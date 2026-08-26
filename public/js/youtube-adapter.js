const API_URL = 'https://www.youtube.com/iframe_api';
const API_TIMEOUT_MS = 10000;
const PLAYER_TIMEOUT_MS = 10000;
let apiPromise = null;

export function createYouTubePlayerVars(origin) {
  return {
    autoplay: 0,
    controls: 0,
    disablekb: 1,
    fs: 0,
    iv_load_policy: 3,
    playsinline: 1,
    rel: 0,
    origin,
  };
}

export function getYouTubePosterSources(videoId) {
  const safeVideoId = encodeURIComponent(String(videoId || ''));
  return {
    primary: `https://i.ytimg.com/vi/${safeVideoId}/maxresdefault.jpg`,
    fallback: `https://i.ytimg.com/vi/${safeVideoId}/hqdefault.jpg`,
  };
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const previousReady = window.onYouTubeIframeAPIReady;
    let script = document.querySelector('script[data-youtube-iframe-api]');

    const cleanup = () => {
      clearTimeout(timeout);
      script?.removeEventListener('error', onError);
      if (window.onYouTubeIframeAPIReady === onReady) {
        window.onYouTubeIframeAPIReady = previousReady;
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      script?.remove();
      reject(error);
    };
    const onError = () => fail(new Error('Failed to load the YouTube IFrame API'));
    const onReady = () => {
      if (typeof previousReady === 'function') previousReady();
      if (settled) return;
      if (!window.YT?.Player) return fail(new Error('The YouTube IFrame API did not initialize correctly'));
      settled = true;
      cleanup();
      resolve(window.YT);
    };
    const timeout = setTimeout(() => fail(new Error('The YouTube IFrame API timed out while loading')), API_TIMEOUT_MS);

    window.onYouTubeIframeAPIReady = onReady;
    if (!script) {
      script = document.createElement('script');
      script.src = API_URL;
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('error', onError, { once: true });
  }).catch((error) => {
    apiPromise = null;
    throw error;
  });

  return apiPromise;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YouTubeAdapter {
  constructor(hostElement, callbacks = {}) {
    this.hostElement = hostElement;
    this.callbacks = callbacks;
    this.player = null;
    this.ready = false;
    this.videoId = null;
    this.creationPromise = null;
    this.isApplyingRemoteState = false;
    this.remoteApplyGeneration = 0;
    this.shouldBePlaying = false;
    this.autoplayRecoveryPromise = null;
    this.presentationState = 'idle';
  }

  async ensurePlayer() {
    if (this.player && this.ready) return this.player;
    if (this.creationPromise) return this.creationPromise;

    this.creationPromise = this.createPlayer().catch((error) => {
      this.resetPlayer();
      this.callbacks.onInitError?.(error);
      throw error;
    });
    return this.creationPromise;
  }

  async createPlayer() {
    const YT = await loadYouTubeApi();
    this.hostElement.replaceChildren();
    const slot = document.createElement('div');
    this.hostElement.append(slot);

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('The YouTube player timed out during initialization')), PLAYER_TIMEOUT_MS);

      try {
        this.player = new YT.Player(slot, {
          width: '100%',
          height: '100%',
          playerVars: createYouTubePlayerVars(window.location.origin),
          events: {
            onReady: () => {
              this.ready = true;
              const iframe = this.player?.getIframe?.();
              iframe?.setAttribute('tabindex', '-1');
              finish();
            },
            onStateChange: (event) => this.handleStateChange(event),
            onPlaybackRateChange: () => this.handleRateChange(),
            onAutoplayBlocked: () => this.handleAutoplayBlocked(),
            onError: (event) => this.callbacks.onError?.(event.data),
          },
        });
      } catch (error) {
        finish(error);
      }
    });

    return this.player;
  }

  handleStateChange(event) {
    if (!this.player) return;
    const states = window.YT.PlayerState;

    if (event.data === states.PLAYING) {
      this.setPresentationState('playing');
    } else if (event.data === states.ENDED) {
      this.setPresentationState('ended');
    } else if (event.data === states.PAUSED || event.data === states.CUED) {
      this.setPresentationState(this.shouldBePlaying ? 'loading' : 'paused');
    } else if (event.data === states.BUFFERING) {
      if (this.shouldBePlaying) this.setPresentationState('loading');
      return;
    }

    if (this.isApplyingRemoteState) return;

    if (event.data === states.PLAYING) {
      this.callbacks.onPlay?.(this.getCurrentTime());
    } else if (event.data === states.PAUSED) {
      this.callbacks.onPause?.(this.getCurrentTime());
    } else if (event.data === states.ENDED) {
      this.callbacks.onEnded?.(Math.max(this.getCurrentTime(), this.getDuration()));
    }
  }

  handleRateChange() {
    if (this.isApplyingRemoteState || !this.player) return;
    this.callbacks.onRateChange?.(this.getPlaybackRate(), this.getCurrentTime());
  }

  handleAutoplayBlocked() {
    if (!this.shouldBePlaying) return;
    this.recoverMutedAutoplay().catch((error) => this.callbacks.onError?.(error.message));
  }

  async runRemoteOperation(operation) {
    const generation = ++this.remoteApplyGeneration;
    this.isApplyingRemoteState = true;
    try {
      return await operation();
    } finally {
      if (generation === this.remoteApplyGeneration) this.isApplyingRemoteState = false;
    }
  }

  async setSupportedPlaybackRate(rate) {
    const requested = Number(rate) || 1;
    const available = this.player?.getAvailablePlaybackRates?.();
    const supported = Array.isArray(available) && available.length ? available : [1];
    if (!supported.some((value) => Math.abs(value - requested) < 0.001)) return false;
    if (Math.abs(this.getPlaybackRate() - requested) > 0.001) this.player.setPlaybackRate(requested);
    return true;
  }

  async apply(playback, targetSeconds) {
    const changedVideo = this.videoId !== playback.videoId;
    this.videoId = playback.videoId;
    this.shouldBePlaying = !playback.paused;
    this.setPresentationState(playback.paused ? 'paused' : 'loading');
    await this.ensurePlayer();

    await this.runRemoteOperation(async () => {
      const position = Math.max(0, targetSeconds);
      if (changedVideo) {
        if (playback.paused) this.player.cueVideoById({ videoId: playback.videoId, startSeconds: position });
        else this.player.loadVideoById({ videoId: playback.videoId, startSeconds: position });
      } else {
        const drift = Math.abs(this.getCurrentTime() - position);
        const threshold = playback.paused ? 0.35 : 1.25;
        if (drift > threshold) this.player.seekTo(position, true);
      }

      await this.setSupportedPlaybackRate(playback.playbackRate);
      if (playback.paused) {
        const state = this.player.getPlayerState?.();
        if (state !== window.YT.PlayerState.CUED && state !== window.YT.PlayerState.PAUSED) {
          this.player.pauseVideo();
        }
        await delay(0);
        this.setPresentationState('paused');
      } else {
        this.setPresentationState('loading');
        this.player.playVideo();
        await this.ensurePlaybackStarted();
      }
    });
  }

  async ensurePlaybackStarted() {
    const started = await this.waitForPlayerState(window.YT.PlayerState.PLAYING, 1600);
    if (!started && this.shouldBePlaying) await this.recoverMutedAutoplay();
  }

  waitForPlayerState(expectedState, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const check = () => {
        if (!this.player || !this.shouldBePlaying) return resolve(false);
        if (this.player.getPlayerState?.() === expectedState) return resolve(true);
        if (performance.now() - startedAt >= timeoutMs) return resolve(false);
        requestAnimationFrame(check);
      };
      check();
    });
  }

  async recoverMutedAutoplay() {
    if (this.autoplayRecoveryPromise) return this.autoplayRecoveryPromise;
    this.autoplayRecoveryPromise = (async () => {
      this.player?.mute?.();
      this.player?.playVideo?.();
      this.callbacks.onMutedAutoplay?.();
      await this.waitForPlayerState(window.YT.PlayerState.PLAYING, 2200);
    })().finally(() => {
      this.autoplayRecoveryPromise = null;
    });
    return this.autoplayRecoveryPromise;
  }

  unmute() {
    if (!this.player || !this.ready) return;
    this.player.unMute?.();
    if (this.shouldBePlaying) this.player.playVideo?.();
  }

  correctDrift(targetSeconds, paused) {
    if (!this.player || !this.ready || this.isApplyingRemoteState) return;
    const drift = this.getCurrentTime() - targetSeconds;
    const threshold = paused ? 0.35 : 1.25;
    if (Math.abs(drift) <= threshold) return;
    this.runRemoteOperation(async () => {
      this.player.seekTo(Math.max(0, targetSeconds), true);
      await delay(0);
    });
  }

  async retry(playback, targetSeconds) {
    this.resetPlayer();
    return this.apply(playback, targetSeconds);
  }

  getCurrentTime() {
    const value = this.player?.getCurrentTime?.();
    return Number.isFinite(value) ? value : 0;
  }

  getDuration() {
    const value = this.player?.getDuration?.();
    return Number.isFinite(value) ? value : 0;
  }

  getPlaybackRate() {
    const value = this.player?.getPlaybackRate?.();
    return Number.isFinite(value) ? value : 1;
  }

  getVideoTitle() {
    const data = this.player?.getVideoData?.();
    return data?.title || '';
  }

  setPresentationState(state) {
    if (this.presentationState === state) return;
    this.presentationState = state;
    this.callbacks.onPresentationChange?.({ state, videoId: this.videoId });
  }

  resetPlayer() {
    try {
      this.player?.destroy?.();
    } catch {
      // A half-created cross-origin player may reject destruction; replacing the host is sufficient.
    }
    this.hostElement.replaceChildren();
    this.player = null;
    this.ready = false;
    this.videoId = null;
    this.creationPromise = null;
    this.isApplyingRemoteState = false;
    this.shouldBePlaying = false;
    this.autoplayRecoveryPromise = null;
    this.remoteApplyGeneration += 1;
    this.setPresentationState('idle');
  }

  destroy() {
    this.resetPlayer();
  }
}
