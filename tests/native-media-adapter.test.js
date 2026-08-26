import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMediaAdapter } from '../public/js/native-media-adapter.js';
import { PlayerAdapter } from '../public/js/player-adapter.js';

const MEDIA_A = { provider: 'youtube', id: 'M7lc1UVf-VE' };
const MEDIA_B = { provider: 'youtube', id: 'dQw4w9WgXcQ' };
const URL_A = 'https://media.example/a.mp4?token=one';
const URL_B = 'https://media.example/b.mp4?token=two';

function playback(playbackUrl, overrides = {}) {
  return {
    media: MEDIA_A,
    playbackUrl,
    paused: true,
    playbackRate: 1,
    ...overrides,
  };
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeVideo {
  constructor() {
    this.autoplay = true;
    this.controls = true;
    this.playsInline = false;
    this.preload = '';
    this.tabIndex = 0;
    this.style = {};
    this.src = '';
    this.title = '';
    this.muted = true;
    this.ended = false;
    this.error = null;
    this.duration = Number.NaN;
    this._currentTime = 0;
    this._playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this._paused = true;
    this.listeners = new Map();
    this.loadCalls = 0;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.seekLog = [];
    this.rateLog = [];
    this.unsupportedRates = new Set();
    this.playResults = [];
    this.pendingPlay = null;
    this.throwOnSeek = false;
    this.emitEndedOnLoad = false;
    this.asyncEvents = false;
    this.pendingEventTasks = [];
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    if (this.throwOnSeek) throw new Error('metadata is not ready');
    this._currentTime = value;
    this.seekLog.push(value);
  }

  get playbackRate() {
    return this._playbackRate;
  }

  set playbackRate(value) {
    if (this.unsupportedRates.has(value)) {
      const error = new Error('playback rate is unsupported');
      error.name = 'NotSupportedError';
      throw error;
    }
    this._playbackRate = value;
    this.rateLog.push(value);
    this.dispatch('ratechange');
  }

  get paused() {
    return this._paused;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  emit(type) {
    const event = { type, target: this };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }

  dispatch(type) {
    if (!this.asyncEvents) {
      this.emit(type);
      return;
    }
    const task = setTimeout(() => {
      this.pendingEventTasks = this.pendingEventTasks.filter((pending) => pending !== task);
      this.emit(type);
    }, 0);
    this.pendingEventTasks.push(task);
  }

  discardPendingEventTasks() {
    for (const task of this.pendingEventTasks) clearTimeout(task);
    this.pendingEventTasks = [];
  }

  abortPendingPlay() {
    if (!this.pendingPlay) return;
    const error = new Error('The play() request was interrupted by a new load request.');
    error.name = 'AbortError';
    const pendingPlay = this.pendingPlay;
    this.pendingPlay = null;
    pendingPlay.reject(error);
  }

  load() {
    this.loadCalls += 1;
    this.abortPendingPlay();
    this.discardPendingEventTasks();
    this._paused = true;
    const previousRate = this._playbackRate;
    this._playbackRate = this.defaultPlaybackRate;
    if (Math.abs(previousRate - this._playbackRate) > 0.001) this.dispatch('ratechange');
    if (this.emitEndedOnLoad) this.dispatch('ended');
  }

  play() {
    this.playCalls += 1;
    this._paused = false;
    this.ended = false;
    const configuredResult = this.playResults.shift();
    const result = configuredResult?.promise || configuredResult || Promise.resolve();
    const pendingPlay = configuredResult?.promise && typeof configuredResult.reject === 'function'
      ? configuredResult
      : null;
    this.pendingPlay = pendingPlay;

    if (!this.asyncEvents) {
      this.emit('play');
      this.emit('playing');
      return Promise.resolve(result).finally(() => {
        if (this.pendingPlay === pendingPlay) this.pendingPlay = null;
      });
    }

    return Promise.resolve(result).then(() => new Promise((resolve) => {
      setTimeout(() => {
        this.emit('play');
        this.emit('playing');
        resolve();
      }, 0);
    })).finally(() => {
      if (this.pendingPlay === pendingPlay) this.pendingPlay = null;
    });
  }

  pause() {
    this.pauseCalls += 1;
    this.abortPendingPlay();
    this._paused = true;
    this.dispatch('pause');
  }
}

function createHarness(t, callbacks = {}) {
  const originalDocument = globalThis.document;
  const videos = [];
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'video');
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const host = {
    children: [],
    replaceChildren(...children) {
      this.children = children;
    },
  };
  const adapter = new NativeMediaAdapter(host, callbacks);
  return { adapter, host, videos };
}

test('NativeMediaAdapter extends PlayerAdapter and mounts a configured video lazily', async (t) => {
  const callbacks = { onPlay() {} };
  const { adapter, host, videos } = createHarness(t, callbacks);

  assert.ok(adapter instanceof PlayerAdapter);
  assert.equal(adapter.hostElement, host);
  assert.equal(adapter.callbacks, callbacks);
  assert.equal(adapter.video, null);
  assert.equal(adapter.getCurrentTime(), 0);
  assert.equal(adapter.getDuration(), 0);
  assert.equal(adapter.getPlaybackRate(), 1);

  await adapter.apply(playback(URL_A), 3);

  assert.equal(videos.length, 1);
  assert.deepEqual(host.children, [videos[0]]);
  assert.equal(videos[0].crossOrigin, 'anonymous');
  assert.equal(videos[0].autoplay, false);
  assert.equal(videos[0].controls, false);
  assert.equal(videos[0].playsInline, true);
  assert.equal(videos[0].preload, 'auto');
  assert.equal(videos[0].tabIndex, -1);
  assert.deepEqual(videos[0].style, { width: '100%', height: '100%', display: 'block' });
});

test('load A -> load B replaces src and positions B while the same URL is not reloaded', async (t) => {
  const { adapter, videos } = createHarness(t);

  await adapter.apply(playback(URL_A), 12);
  const video = videos[0];
  assert.equal(video.src, URL_A);
  assert.equal(video.loadCalls, 1);
  assert.deepEqual(video.seekLog, [12]);

  video.seekLog.length = 0;
  await adapter.apply(playback(URL_B, { media: MEDIA_B }), 4);
  assert.equal(adapter.video, video);
  assert.equal(video.src, URL_B);
  assert.equal(video.loadCalls, 2);
  assert.deepEqual(video.seekLog, [4]);

  video.seekLog.length = 0;
  await adapter.apply(playback(URL_B, { media: MEDIA_A }), 4.35);
  assert.equal(video.loadCalls, 2);
  assert.deepEqual(video.seekLog, []);
});

test('paused apply seeks, changes rate, pauses playback, and suppresses remote callbacks', async (t) => {
  const callbacks = { pauses: [], rates: [] };
  const { adapter, videos } = createHarness(t, {
    onPause: (position) => callbacks.pauses.push(position),
    onRateChange: (rate, position) => callbacks.rates.push([rate, position]),
  });

  await adapter.apply(playback(URL_A, { paused: false }), 8);
  const video = videos[0];
  video.seekLog.length = 0;

  await adapter.apply(playback(URL_A, { paused: true, playbackRate: 1.5 }), -5);

  assert.equal(video.playCalls, 1);
  assert.equal(video.pauseCalls, 1);
  assert.equal(video.paused, true);
  assert.deepEqual(video.seekLog, [0]);
  assert.equal(video.playbackRate, 1.5);
  assert.deepEqual(callbacks.pauses, []);
  assert.deepEqual(callbacks.rates, []);
  assert.equal(adapter.presentationState, 'paused');
});

test('playing apply calls and awaits video.play without echoing the programmatic play event', async (t) => {
  const presentations = [];
  const plays = [];
  const { adapter, videos } = createHarness(t, {
    onPlay: (position) => plays.push(position),
    onPresentationChange: ({ state }) => presentations.push(state),
  });
  await adapter.apply(playback(URL_A), 5);
  const video = videos[0];
  const pendingPlay = deferred();
  video.playResults.push(pendingPlay.promise);
  video.asyncEvents = true;
  presentations.length = 0;

  let settled = false;
  const applying = adapter.apply(playback(URL_A, { paused: false }), 7).then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.equal(video.playCalls, 1);
  assert.equal(video.pauseCalls, 0);
  assert.equal(settled, false);
  assert.deepEqual(plays, []);
  assert.deepEqual(presentations, ['loading']);

  pendingPlay.resolve();
  await applying;
  assert.equal(settled, true);
  assert.equal(video.paused, false);
  assert.equal(adapter.presentationState, 'playing');
  assert.deepEqual(presentations, ['loading', 'playing']);
});

test('same-source apply uses the exact paused and playing drift thresholds', async (t) => {
  const { adapter, videos } = createHarness(t);
  await adapter.apply(playback(URL_A), 10);
  const video = videos[0];

  video.seekLog.length = 0;
  video._currentTime = 10;
  await adapter.apply(playback(URL_A), 10.35);
  assert.deepEqual(video.seekLog, []);

  await adapter.apply(playback(URL_A), 10.351);
  assert.deepEqual(video.seekLog, [10.351]);

  video.seekLog.length = 0;
  video._currentTime = 10;
  await adapter.apply(playback(URL_A, { paused: false }), 11.25);
  assert.deepEqual(video.seekLog, []);

  await adapter.apply(playback(URL_A, { paused: false }), 11.251);
  assert.deepEqual(video.seekLog, [11.251]);
});

test('correctDrift respects both thresholds, clamps negative targets, and ignores remote apply', async (t) => {
  const { adapter, videos } = createHarness(t);
  assert.doesNotThrow(() => adapter.correctDrift(20, false));
  await adapter.apply(playback(URL_A), 10);
  const video = videos[0];

  video.seekLog.length = 0;
  video._currentTime = 10;
  adapter.correctDrift(10.35, true);
  assert.deepEqual(video.seekLog, []);

  adapter.correctDrift(10.351, true);
  assert.deepEqual(video.seekLog, [10.351]);
  await nextTask();

  video.seekLog.length = 0;
  video._currentTime = 10;
  adapter.correctDrift(11.25, false);
  assert.deepEqual(video.seekLog, []);

  adapter.correctDrift(11.251, false);
  assert.deepEqual(video.seekLog, [11.251]);
  await nextTask();

  video.seekLog.length = 0;
  video._currentTime = 10;
  adapter.correctDrift(-2, true);
  assert.deepEqual(video.seekLog, [0]);
  await nextTask();

  video.seekLog.length = 0;
  adapter.isApplyingRemoteState = true;
  adapter.correctDrift(50, false);
  assert.deepEqual(video.seekLog, []);
  adapter.isApplyingRemoteState = false;
});

test('rate changes are deduplicated during apply and local changes report rate and position', async (t) => {
  const changes = [];
  const { adapter, videos } = createHarness(t, {
    onRateChange: (rate, position) => changes.push([rate, position]),
  });
  await adapter.apply(playback(URL_A, { playbackRate: 1.5 }), 6);
  const video = videos[0];

  assert.deepEqual(video.rateLog, [1.5]);
  assert.deepEqual(changes, []);
  await adapter.apply(playback(URL_A, { playbackRate: 1.5 }), 6);
  assert.deepEqual(video.rateLog, [1.5]);

  video._currentTime = 9;
  video._playbackRate = 0.75;
  video.emit('ratechange');
  assert.deepEqual(changes, [[0.75, 9]]);

  video._playbackRate = Number.NaN;
  assert.equal(adapter.getPlaybackRate(), 1);
  video._playbackRate = 1;
  video.unsupportedRates.add(2);
  assert.equal(adapter.setPlaybackRate(2), false);
  assert.equal(video.playbackRate, 1);
});

test('source reload rate resets and explicit rate restores are both suppressed', async (t) => {
  const changes = [];
  const { adapter } = createHarness(t, {
    onRateChange: (rate, position) => changes.push([rate, position]),
  });
  const video = adapter.ensureVideo();
  video.asyncEvents = true;

  await adapter.apply(playback(URL_A, { playbackRate: 1.5 }), 6);
  await nextTask();
  await adapter.apply(playback(URL_B, { media: MEDIA_B, playbackRate: 1.5 }), 7);
  await nextTask();

  assert.equal(video.playbackRate, 1.5);
  assert.deepEqual(changes, []);
  video._currentTime = 8;
  video._playbackRate = 0.75;
  video.emit('ratechange');
  assert.deepEqual(changes, [[0.75, 8]]);
});

test('queued native events from a remote apply stay suppressed after their media task runs', async (t) => {
  const callbacks = { plays: [], pauses: [], rates: [] };
  const { adapter } = createHarness(t, {
    onPlay: (position) => callbacks.plays.push(position),
    onPause: (position) => callbacks.pauses.push(position),
    onRateChange: (rate, position) => callbacks.rates.push([rate, position]),
  });
  const video = adapter.ensureVideo();
  video.asyncEvents = true;
  video._paused = false;

  await adapter.apply(playback(URL_A, { paused: true, playbackRate: 1.5 }), 4);
  await nextTask();
  await adapter.apply(playback(URL_A, { paused: false, playbackRate: 1.5 }), 4);
  await nextTask();
  assert.equal(adapter.presentationState, 'playing');
  await adapter.apply(playback(URL_A, { paused: true, playbackRate: 1.5 }), 4);
  await nextTask();

  assert.deepEqual(callbacks, { plays: [], pauses: [], rates: [] });
  assert.equal(adapter.presentationState, 'paused');
});

test('media-originated playing and pause events report their current position', async (t) => {
  const plays = [];
  const pauses = [];
  const { adapter, videos } = createHarness(t, {
    onPlay: (position) => plays.push(position),
    onPause: (position) => pauses.push(position),
  });
  await adapter.apply(playback(URL_A), 5);
  const video = videos[0];
  video._currentTime = 12;

  video.emit('play');
  assert.deepEqual(plays, []);
  video.emit('playing');
  video.emit('pause');
  assert.deepEqual(plays, [12]);
  assert.deepEqual(pauses, [12]);

  video.ended = true;
  video.emit('pause');
  assert.deepEqual(pauses, [12]);
});

test('waiting and native media errors use the common presentation and error callbacks', async (t) => {
  const presentations = [];
  const errors = [];
  const { adapter, videos } = createHarness(t, {
    onPresentationChange: ({ state }) => presentations.push(state),
    onError: (error) => errors.push(error),
  });
  await adapter.apply(playback(URL_A, { paused: false }), 1);
  const video = videos[0];

  video.emit('waiting');
  assert.equal(presentations.at(-1), 'loading');
  video.error = { code: 4 };
  video.emit('error');
  assert.deepEqual(errors, [4]);
  video.error = null;
  video.emit('error');
  assert.equal(errors[1].type, 'error');
});

test('play failures restore remote state and NotAllowedError retries muted', async (t) => {
  const mutedAutoplay = [];
  const { adapter } = createHarness(t, {
    onMutedAutoplay: () => mutedAutoplay.push(true),
  });
  const video = adapter.ensureVideo();
  video.asyncEvents = true;

  const failedPlay = deferred();
  video.playResults.push(failedPlay.promise);
  const failedApply = adapter.apply(playback(URL_A, { paused: false }), 2);
  const networkError = new Error('media failed');
  failedPlay.reject(networkError);
  await assert.rejects(failedApply, networkError);
  assert.equal(adapter.isApplyingRemoteState, false);

  await adapter.apply(playback(URL_A), 2);
  assert.equal(adapter.presentationState, 'paused');

  const blockedPlay = deferred();
  video.playResults.push(blockedPlay.promise);
  const recoveredApply = adapter.apply(playback(URL_A, { paused: false }), 2);
  const blockedError = new Error('autoplay is blocked');
  blockedError.name = 'NotAllowedError';
  blockedPlay.reject(blockedError);
  await recoveredApply;

  assert.equal(video.muted, true);
  assert.equal(video.playCalls, 3);
  assert.deepEqual(mutedAutoplay, [true]);
  assert.equal(adapter.presentationState, 'playing');
  assert.equal(adapter.isApplyingRemoteState, false);
});

test('ended reports the furthest known position and is suppressed during remote apply', async (t) => {
  const ended = [];
  const presentations = [];
  const { adapter, videos } = createHarness(t, {
    onEnded: (position) => ended.push(position),
    onPresentationChange: ({ state }) => presentations.push(state),
  });
  await adapter.apply(playback(URL_A), 0);
  const video = videos[0];
  video._currentTime = 19.8;
  video.duration = 20;
  adapter.shouldBePlaying = true;
  adapter.setPresentationState('playing');
  presentations.length = 0;
  video.ended = true;
  video.emit('pause');
  assert.deepEqual(presentations, []);
  video.emit('ended');

  assert.deepEqual(ended, [20]);
  assert.deepEqual(presentations, ['ended']);

  video.emitEndedOnLoad = true;
  await adapter.apply(playback(URL_B, { media: MEDIA_B }), 2);
  assert.deepEqual(ended, [20]);
  assert.equal(adapter.presentationState, 'paused');
});

test('getters, delayed metadata seek, unmute, retry, and destroy complete the adapter contract', async (t) => {
  const ended = [];
  const { adapter, host, videos } = createHarness(t, {
    onEnded: (position) => ended.push(position),
  });
  const firstApply = adapter.apply(playback(URL_A), 2);
  await firstApply;
  const firstVideo = videos[0];
  firstVideo.title = 'Native title';
  firstVideo._currentTime = Number.POSITIVE_INFINITY;
  firstVideo.duration = Number.NaN;
  assert.equal(adapter.getCurrentTime(), 0);
  assert.equal(adapter.getDuration(), 0);
  assert.equal(adapter.getVideoTitle(), 'Native title');

  firstVideo.throwOnSeek = true;
  await adapter.apply(playback(URL_B, { media: MEDIA_B }), 14);
  assert.equal(adapter.pendingSeekSeconds, 14);
  firstVideo.throwOnSeek = false;
  firstVideo.emit('loadedmetadata');
  assert.equal(firstVideo.currentTime, 14);
  assert.equal(adapter.pendingSeekSeconds, null);

  await adapter.apply(playback(URL_B, { media: MEDIA_B, paused: false }), 14);
  const playCallsBeforeUnmute = firstVideo.playCalls;
  adapter.unmute();
  await Promise.resolve();
  assert.equal(firstVideo.muted, false);
  assert.equal(firstVideo.playCalls, playCallsBeforeUnmute + 1);

  await adapter.retry(playback(URL_A), 7);
  const secondVideo = videos[1];
  assert.notEqual(secondVideo, firstVideo);
  assert.deepEqual(host.children, [secondVideo]);
  assert.equal(secondVideo.src, URL_A);
  assert.equal(secondVideo.currentTime, 7);
  firstVideo.emit('ended');
  assert.deepEqual(ended, []);
  assert.equal(firstVideo.src, '');

  adapter.destroy();
  assert.deepEqual(host.children, []);
  assert.equal(adapter.video, null);
  assert.equal(adapter.ready, false);
  assert.equal(secondVideo.src, '');
  secondVideo.emit('ended');
  assert.deepEqual(ended, []);
});

test('a newer load aborts a stale play promise without surfacing an obsolete error', async (t) => {
  const { adapter, videos } = createHarness(t);
  const videoCreated = adapter.ensureVideo();
  const pendingPlay = deferred();
  videoCreated.asyncEvents = true;
  videoCreated.playResults.push(pendingPlay);

  const loadingA = adapter.apply(playback(URL_A, { paused: false }), 9);
  await Promise.resolve();
  const loadingB = adapter.apply(playback(URL_B, { media: MEDIA_B, paused: true }), 3);
  await Promise.all([loadingA, loadingB]);
  const video = videos[0];
  assert.equal(adapter.playbackUrl, URL_B);
  assert.equal(video.src, URL_B);
  assert.equal(video.currentTime, 3);
  assert.equal(video.paused, true);
  assert.equal(adapter.presentationState, 'paused');
});

test('apply requires only a non-empty playbackUrl as its source input', async (t) => {
  const { adapter, videos } = createHarness(t);

  await assert.rejects(adapter.apply({}, 0), /NativeMediaAdapter requires playbackUrl/);
  await assert.rejects(adapter.apply({ playbackUrl: '   ' }, 0), /NativeMediaAdapter requires playbackUrl/);
  assert.equal(videos.length, 0);

  await assert.doesNotReject(adapter.apply({ playbackUrl: URL_A }, 0));
  assert.equal(videos.length, 1);
  assert.equal(videos[0].playCalls, 1);
});
