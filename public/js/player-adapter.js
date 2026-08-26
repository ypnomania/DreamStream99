export class PlayerAdapter {
  constructor(hostElement, callbacks = {}) {
    this.hostElement = hostElement;
    this.callbacks = callbacks;
  }

  async apply(_playback, _targetSeconds) {
    throw this.notImplemented('apply');
  }

  correctDrift(_targetSeconds, _paused) {
    throw this.notImplemented('correctDrift');
  }

  getCurrentTime() {
    throw this.notImplemented('getCurrentTime');
  }

  getDuration() {
    throw this.notImplemented('getDuration');
  }

  getPlaybackRate() {
    throw this.notImplemented('getPlaybackRate');
  }

  getVideoTitle() {
    throw this.notImplemented('getVideoTitle');
  }

  unmute() {
    throw this.notImplemented('unmute');
  }

  async retry(_playback, _targetSeconds) {
    throw this.notImplemented('retry');
  }

  destroy() {}

  notImplemented(method) {
    return new Error(`${this.constructor.name}.${method}() must be implemented`);
  }
}
