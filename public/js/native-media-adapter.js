import { PlayerAdapter } from './player-adapter.js';

const PAUSED_DRIFT_THRESHOLD_SECONDS = 0.35;
const PLAYING_DRIFT_THRESHOLD_SECONDS = 1.25;
const RATE_EPSILON = 0.001;
const EVENT_SUPPRESSION_TIMEOUT_MS = 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PlayerAdapter implementation for a direct URL handled by HTMLVideoElement.
 *
 * `playbackUrl` is intentionally an adapter-only value. It is expected to be
 * merged into the shared playback snapshot after media resolution and must not
 * be persisted as part of MediaRef.
 */
export class NativeMediaAdapter extends PlayerAdapter {
  constructor(hostElement, callbacks = {}) {
    super(hostElement, callbacks);
    this.video = null;
    this.ready = false;
    this.playbackUrl = null;
    this.media = null;
    this.pendingSeekSeconds = null;
    this.isApplyingRemoteState = false;
    this.remoteApplyGeneration = 0;
    this.shouldBePlaying = false;
    this.autoplayRecoveryPromise = null;
    this.autoplayRecoveryGeneration = null;
    this.autoplayRecoveryVideo = null;
    this.presentationState = 'idle';
    this.videoEventHandlers = null;
    this.suppressedMediaEvents = new Map();
  }

  ensureVideo() {
    if (this.video) return this.video;

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.autoplay = false;
    video.controls = false;
    video.playsInline = true;
    video.preload = 'auto';
    video.tabIndex = -1;
    if (video.style) {
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.display = 'block';
    }

    this.videoEventHandlers = {
      play: () => this.handlePlay(),
      playing: () => this.handlePlaying(),
      pause: () => this.handlePause(),
      waiting: () => this.handleWaiting(),
      ratechange: () => this.handleRateChange(),
      ended: () => this.handleEnded(),
      loadedmetadata: () => this.handleLoadedMetadata(),
      error: (event) => this.handleError(event),
    };
    for (const [type, handler] of Object.entries(this.videoEventHandlers)) {
      video.addEventListener(type, handler);
    }

    this.video = video;
    this.ready = true;
    this.hostElement.replaceChildren(video);
    return video;
  }

  handlePlay() {
    if (!this.video) return;
    if (this.consumeSuppressedMediaEvent('play')) return;
    this.setPresentationState('loading');
  }

  handlePlaying() {
    if (!this.video) return;
    if (this.consumeSuppressedMediaEvent('playing')) return;
    this.setPresentationState('playing');
    if (this.isApplyingRemoteState) return;
    this.callbacks.onPlay?.(this.getCurrentTime());
  }

  handlePause() {
    if (!this.video) return;
    if (this.consumeSuppressedMediaEvent('pause')) return;
    if (this.video.ended) return;
    this.setPresentationState(this.shouldBePlaying ? 'loading' : 'paused');
    if (this.isApplyingRemoteState) return;
    this.callbacks.onPause?.(this.getCurrentTime());
  }

  handleWaiting() {
    if (this.video && this.shouldBePlaying) this.setPresentationState('loading');
  }

  handleRateChange() {
    if (!this.video || this.consumeSuppressedMediaEvent('ratechange')) return;
    if (this.isApplyingRemoteState) return;
    this.callbacks.onRateChange?.(this.getPlaybackRate(), this.getCurrentTime());
  }

  handleEnded() {
    if (!this.video) return;
    this.setPresentationState('ended');
    if (this.isApplyingRemoteState) return;
    this.callbacks.onEnded?.(Math.max(this.getCurrentTime(), this.getDuration()));
  }

  handleLoadedMetadata() {
    if (this.pendingSeekSeconds === null) return;
    const position = this.pendingSeekSeconds;
    this.pendingSeekSeconds = null;
    this.seekTo(position);
  }

  handleError(event) {
    const code = this.video?.error?.code;
    this.callbacks.onError?.(Number.isFinite(code) ? code : event);
  }

  suppressNextMediaEvent(type) {
    const token = { type, timeout: null };
    const tokens = this.suppressedMediaEvents.get(type) || [];
    tokens.push(token);
    this.suppressedMediaEvents.set(type, tokens);
    token.timeout = setTimeout(() => this.cancelSuppressedMediaEvent(token), EVENT_SUPPRESSION_TIMEOUT_MS);
    token.timeout?.unref?.();
    return token;
  }

  consumeSuppressedMediaEvent(type) {
    const tokens = this.suppressedMediaEvents.get(type);
    if (!tokens?.length) return false;
    const token = tokens.shift();
    clearTimeout(token.timeout);
    if (!tokens.length) this.suppressedMediaEvents.delete(type);
    return true;
  }

  cancelSuppressedMediaEvent(token) {
    if (!token) return;
    const tokens = this.suppressedMediaEvents.get(token.type);
    const index = tokens?.indexOf(token) ?? -1;
    if (index < 0) return;
    tokens.splice(index, 1);
    clearTimeout(token.timeout);
    if (!tokens.length) this.suppressedMediaEvents.delete(token.type);
  }

  clearSuppressedMediaEvents() {
    for (const tokens of this.suppressedMediaEvents.values()) {
      for (const token of tokens) clearTimeout(token.timeout);
    }
    this.suppressedMediaEvents.clear();
  }

  async runRemoteOperation(operation) {
    const generation = ++this.remoteApplyGeneration;
    this.isApplyingRemoteState = true;
    try {
      return await operation(generation);
    } finally {
      if (generation === this.remoteApplyGeneration) this.isApplyingRemoteState = false;
    }
  }

  seekTo(targetSeconds) {
    if (!this.video) return false;
    const position = Math.max(0, targetSeconds);
    try {
      this.video.currentTime = position;
      this.pendingSeekSeconds = null;
      return true;
    } catch {
      // Some browsers reject a seek until metadata for the new source arrives.
      this.pendingSeekSeconds = position;
      return false;
    }
  }

  setPlaybackRate(rate, suppressEvent = false) {
    if (!this.video) return false;
    const requested = Number(rate) || 1;
    if (Math.abs(this.getPlaybackRate() - requested) > RATE_EPSILON) {
      const token = suppressEvent ? this.suppressNextMediaEvent('ratechange') : null;
      try {
        this.video.playbackRate = requested;
      } catch (error) {
        this.cancelSuppressedMediaEvent(token);
        if (error?.name === 'NotSupportedError') return false;
        throw error;
      }
    }
    return true;
  }

  playVideo(suppressEvent = false, video = this.video) {
    if (!video) return Promise.resolve();
    const shouldSuppressEvents = suppressEvent && video.paused;
    const playToken = shouldSuppressEvents
      ? this.suppressNextMediaEvent('play')
      : null;
    const playingToken = shouldSuppressEvents
      ? this.suppressNextMediaEvent('playing')
      : null;
    const cancelTokens = () => {
      this.cancelSuppressedMediaEvent(playToken);
      this.cancelSuppressedMediaEvent(playingToken);
    };
    let playResult;
    try {
      playResult = video.play();
    } catch (error) {
      cancelTokens();
      throw error;
    }
    return Promise.resolve(playResult).catch((error) => {
      cancelTokens();
      throw error;
    });
  }

  async recoverMutedAutoplay(generation) {
    if (
      this.autoplayRecoveryPromise
      && this.autoplayRecoveryGeneration === generation
      && this.autoplayRecoveryVideo === this.video
    ) {
      return this.autoplayRecoveryPromise;
    }
    const video = this.video;
    const recoveryPromise = (async () => {
      if (!video || video !== this.video || generation !== this.remoteApplyGeneration || !this.shouldBePlaying) return;
      video.muted = true;
      const playPromise = this.playVideo(true, video);
      this.callbacks.onMutedAutoplay?.();
      await playPromise;
    })();
    this.autoplayRecoveryPromise = recoveryPromise;
    this.autoplayRecoveryGeneration = generation;
    this.autoplayRecoveryVideo = video;
    try {
      return await recoveryPromise;
    } finally {
      if (this.autoplayRecoveryPromise === recoveryPromise) {
        this.autoplayRecoveryPromise = null;
        this.autoplayRecoveryGeneration = null;
        this.autoplayRecoveryVideo = null;
      }
    }
  }

  async apply(playback, targetSeconds) {
    if (typeof playback?.playbackUrl !== 'string' || !playback.playbackUrl.trim()) {
      throw new Error('NativeMediaAdapter requires playbackUrl');
    }

    const changedMedia = this.playbackUrl !== playback.playbackUrl;
    this.playbackUrl = playback.playbackUrl;
    this.media = playback.media || null;
    this.shouldBePlaying = !playback.paused;
    this.setPresentationState(playback.paused ? 'paused' : 'loading');
    const video = this.ensureVideo();

    await this.runRemoteOperation(async (generation) => {
      const position = Math.max(0, targetSeconds);
      if (changedMedia) {
        this.clearSuppressedMediaEvents();
        const defaultRate = Number.isFinite(video.defaultPlaybackRate) ? video.defaultPlaybackRate : 1;
        const loadRateToken = Math.abs(this.getPlaybackRate() - defaultRate) > RATE_EPSILON
          ? this.suppressNextMediaEvent('ratechange')
          : null;
        try {
          video.src = playback.playbackUrl;
          video.load();
        } catch (error) {
          this.cancelSuppressedMediaEvent(loadRateToken);
          throw error;
        }
        this.seekTo(position);
      } else {
        const drift = Math.abs(this.getCurrentTime() - position);
        const threshold = playback.paused
          ? PAUSED_DRIFT_THRESHOLD_SECONDS
          : PLAYING_DRIFT_THRESHOLD_SECONDS;
        if (drift > threshold) this.seekTo(position);
      }

      this.setPlaybackRate(playback.playbackRate, true);
      if (playback.paused) {
        if (!video.paused) {
          const pauseToken = this.suppressNextMediaEvent('pause');
          try {
            video.pause();
          } catch (error) {
            this.cancelSuppressedMediaEvent(pauseToken);
            throw error;
          }
        }
        await delay(0);
        if (generation === this.remoteApplyGeneration) this.setPresentationState('paused');
      } else {
        this.setPresentationState('loading');
        try {
          await this.playVideo(true);
        } catch (error) {
          // A newer apply() can replace the source and abort this play request.
          // That stale rejection must not surface as an error for the new media.
          if (generation !== this.remoteApplyGeneration) return;
          if (error?.name !== 'NotAllowedError' || !this.shouldBePlaying) throw error;
          try {
            await this.recoverMutedAutoplay(generation);
          } catch (recoveryError) {
            if (generation !== this.remoteApplyGeneration) return;
            throw recoveryError;
          }
        }
        if (generation === this.remoteApplyGeneration && this.shouldBePlaying) {
          this.setPresentationState('playing');
        }
      }
    });
  }

  correctDrift(targetSeconds, paused) {
    if (!this.video || !this.ready || this.isApplyingRemoteState) return;
    const drift = this.getCurrentTime() - targetSeconds;
    const threshold = paused
      ? PAUSED_DRIFT_THRESHOLD_SECONDS
      : PLAYING_DRIFT_THRESHOLD_SECONDS;
    if (Math.abs(drift) <= threshold) return;
    this.runRemoteOperation(async () => {
      this.seekTo(Math.max(0, targetSeconds));
      await delay(0);
    });
  }

  async retry(playback, targetSeconds) {
    this.resetVideo();
    return this.apply(playback, targetSeconds);
  }

  getCurrentTime() {
    const value = this.video?.currentTime;
    return Number.isFinite(value) ? value : 0;
  }

  getDuration() {
    const value = this.video?.duration;
    return Number.isFinite(value) ? value : 0;
  }

  getPlaybackRate() {
    const value = this.video?.playbackRate;
    return Number.isFinite(value) ? value : 1;
  }

  getVideoTitle() {
    return this.video?.title || '';
  }

  unmute() {
    if (!this.video || !this.ready) return;
    this.video.muted = false;
    if (!this.shouldBePlaying) return;
    this.video.play()?.catch((error) => this.callbacks.onError?.(error));
  }

  setPresentationState(state) {
    if (this.presentationState === state) return;
    this.presentationState = state;
    this.callbacks.onPresentationChange?.({
      state,
      videoId: this.media?.id || null,
    });
  }

  resetVideo() {
    const video = this.video;
    if (video && this.videoEventHandlers) {
      for (const [type, handler] of Object.entries(this.videoEventHandlers)) {
        video.removeEventListener(type, handler);
      }
    }
    try {
      video?.pause?.();
      if (typeof video?.removeAttribute === 'function') {
        video.removeAttribute('src');
        video.load?.();
      }
    } catch {
      // A partially initialized media element can reject cleanup; removing it is enough.
    }
    this.hostElement.replaceChildren();
    this.video = null;
    this.ready = false;
    this.playbackUrl = null;
    this.media = null;
    this.pendingSeekSeconds = null;
    this.isApplyingRemoteState = false;
    this.shouldBePlaying = false;
    this.autoplayRecoveryPromise = null;
    this.autoplayRecoveryGeneration = null;
    this.autoplayRecoveryVideo = null;
    this.videoEventHandlers = null;
    this.clearSuppressedMediaEvents();
    this.remoteApplyGeneration += 1;
    this.setPresentationState('idle');
  }

  destroy() {
    this.resetVideo();
  }
}
