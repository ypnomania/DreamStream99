export class MediaRecoveryExhaustedError extends Error {
  constructor(cause) {
    super(cause?.message || 'Media recovery failed');
    this.name = 'MediaRecoveryExhaustedError';
    this.cause = cause;
  }
}

export const YOUTUBE_AUTH_REQUIRED_MESSAGE = 'YouTube is requiring verification from the media server. Try another video, or try again later after the site operator refreshes the server\'s YouTube cookies or PO token.';

const YOUTUBE_AUTH_ERROR_CODES = new Set([
  'youtube_auth_required',
  'youtube_bot_check',
  'bot_check_required',
]);

export function isYouTubeAuthRequiredError(error) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const code = typeof current.code === 'string' ? current.code.trim().toLowerCase() : '';
    const message = typeof current.message === 'string' ? current.message : '';
    if (
      YOUTUBE_AUTH_ERROR_CODES.has(code)
      || /sign in to confirm|not a bot|bot[-_ ]?check|youtube.{0,40}(?:auth|verification).{0,20}required/i.test(message)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function mediaErrorMessage(error, fallback = 'Media playback failed') {
  if (isYouTubeAuthRequiredError(error)) return YOUTUBE_AUTH_REQUIRED_MESSAGE;
  return typeof error?.message === 'string' && error.message ? error.message : fallback;
}

export function isRecoverableMediaError(error) {
  if (isYouTubeAuthRequiredError(error)) return false;
  return [401, 403, 404, 410].includes(error?.status);
}

export function shouldAutomaticallyRecoverMediaError(error, { nativeAdapterActive = false } = {}) {
  if (isYouTubeAuthRequiredError(error)) return false;
  return isRecoverableMediaError(error) || nativeAdapterActive;
}

/**
 * Bounds stale relay recovery per active media item and shares one refresh
 * flight across duplicate HTMLMediaElement error events.
 */
export class MediaRecoveryController {
  constructor({
    maxAttempts = 2,
    retryDelayMs = 400,
    stableWindowMs = 30_000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = (timer) => clearTimeout(timer),
  } = {}) {
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.stableWindowMs = stableWindowMs;
    this.delay = delay;
    this.schedule = schedule;
    this.cancel = cancel;
    this.activeKey = null;
    this.states = new Map();
  }

  activate(key) {
    const nextKey = typeof key === 'string' && key ? key : null;
    if (this.activeKey === nextKey) return;
    this.clear();
    this.activeKey = nextKey;
  }

  recover(key, operation) {
    if (!key || typeof operation !== 'function') {
      return Promise.reject(new TypeError('Media recovery requires a key and operation'));
    }
    if (this.activeKey !== key) this.activate(key);
    const state = this.states.get(key) || { attempts: 0, inFlight: null, resetTimer: null };
    this.states.set(key, state);
    if (state.inFlight) return state.inFlight;
    if (state.attempts >= this.maxAttempts) {
      return Promise.reject(new MediaRecoveryExhaustedError());
    }

    this.cancel(state.resetTimer);
    state.resetTimer = null;
    const task = this.runAttempts(key, state, operation).finally(() => {
      if (state.inFlight === task) state.inFlight = null;
    });
    state.inFlight = task;
    return task;
  }

  async runAttempts(key, state, operation) {
    let lastError = null;
    while (state.attempts < this.maxAttempts) {
      const attempt = ++state.attempts;
      if (attempt > 1) await this.delay(this.retryDelayMs * (attempt - 1));
      try {
        const result = await operation(attempt);
        if (this.activeKey === key) {
          state.resetTimer = this.schedule(() => this.reset(key), this.stableWindowMs);
          state.resetTimer?.unref?.();
        }
        return result;
      } catch (error) {
        if (error?.name === 'AbortError') {
          state.attempts -= 1;
          throw error;
        }
        lastError = error;
      }
    }
    throw new MediaRecoveryExhaustedError(lastError);
  }

  reset(key) {
    const state = this.states.get(key);
    if (!state) return;
    this.cancel(state.resetTimer);
    this.states.delete(key);
  }

  clear() {
    for (const state of this.states.values()) this.cancel(state.resetTimer);
    this.states.clear();
  }

  destroy() {
    this.clear();
    this.activeKey = null;
  }
}
