import { NativeMediaAdapter } from './native-media-adapter.js';

function getMedia(source) {
  return source?.media && typeof source.media === 'object' ? source.media : source;
}

export function getPlayerAdapterRoute(source) {
  const media = getMedia(source);
  if (!media || typeof media.provider !== 'string' || !media.provider.trim()) {
    throw new TypeError('PlaybackState.media.provider is required');
  }
  if (typeof source?.playbackUrl !== 'string' || !source.playbackUrl.trim()) {
    throw new TypeError('PlaybackState.playbackUrl is required');
  }
  return 'native';
}

export function createPlayerAdapter(source, hostElement, callbacks = {}) {
  getPlayerAdapterRoute(source);
  return new NativeMediaAdapter(hostElement, callbacks);
}

export class PlayerAdapterRouter {
  constructor(hostElement, callbacks = {}, adapterFactory = createPlayerAdapter) {
    this.hostElement = hostElement;
    this.callbacks = callbacks;
    this.adapterFactory = adapterFactory;
    this.adapter = null;
    this.activeRoute = null;
  }

  select(source) {
    const nextRoute = getPlayerAdapterRoute(source);
    if (this.adapter && this.activeRoute === nextRoute) return this.adapter;

    this.destroy();
    const nextAdapter = this.adapterFactory(source, this.hostElement, this.callbacks);
    this.adapter = nextAdapter;
    this.activeRoute = nextRoute;
    return nextAdapter;
  }

  destroy() {
    if (!this.adapter) {
      this.activeRoute = null;
      return;
    }

    const currentAdapter = this.adapter;
    currentAdapter.destroy();
    this.adapter = null;
    this.activeRoute = null;
  }
}
