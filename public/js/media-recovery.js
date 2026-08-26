export class MediaRecoveryExhaustedError extends Error {
  constructor(cause) {
    super(cause?.message || 'Media recovery failed');
    this.name = 'MediaRecoveryExhaustedError';
    this.cause = cause;
  }
}

export function isRecoverableMediaError(error) {
  return [401, 403, 404, 410].includes(error?.status);
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
