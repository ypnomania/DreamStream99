import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMediaAdapter } from '../public/js/native-media-adapter.js';
import {
  createPlayerAdapter,
  getPlayerAdapterRoute,
  PlayerAdapterRouter,
} from '../public/js/player-adapter-router.js';

const hostElement = { replaceChildren() {} };
const YOUTUBE_PLAYBACK = {
  media: { provider: 'youtube', id: 'M7lc1UVf-VE' },
  playbackUrl: 'https://media.example/relay/session',
};

test('adapter factory mounts only native media for resolved playback URLs', () => {
  const callbacks = { onPlay() {} };
  const adapter = createPlayerAdapter(YOUTUBE_PLAYBACK, hostElement, callbacks);

  assert.ok(adapter instanceof NativeMediaAdapter);
  assert.equal(adapter.hostElement, hostElement);
  assert.equal(adapter.callbacks, callbacks);
  assert.equal(getPlayerAdapterRoute(YOUTUBE_PLAYBACK), 'native');
});

test('adapter routing rejects unresolved MediaRefs instead of loading a third-party player', () => {
  assert.throws(
    () => getPlayerAdapterRoute({ media: { provider: 'youtube', id: 'M7lc1UVf-VE' } }),
    /playbackUrl is required/,
  );
  assert.throws(() => getPlayerAdapterRoute(null), /media\.provider is required/);
  assert.throws(
    () => getPlayerAdapterRoute({ media: { provider: '  ', id: 'stream' }, playbackUrl: 'https://media.example/x' }),
    /media\.provider is required/,
  );
});

test('router reuses one native adapter across resolved media changes and destroys it explicitly', () => {
  const events = [];
  const callbacks = { onPause() {} };
  const factory = (source, receivedHost, receivedCallbacks) => {
    events.push(`create:${source.media.id}`);
    assert.equal(receivedHost, hostElement);
    assert.equal(receivedCallbacks, callbacks);
    return { destroy: () => events.push('destroy:native') };
  };
  const router = new PlayerAdapterRouter(hostElement, callbacks, factory);

  const first = router.select(YOUTUBE_PLAYBACK);
  const second = router.select({
    media: { provider: 'youtube', id: 'dQw4w9WgXcQ' },
    playbackUrl: 'https://media.example/relay/next',
  });

  assert.equal(second, first);
  assert.equal(router.activeRoute, 'native');
  assert.deepEqual(events, ['create:M7lc1UVf-VE']);

  router.destroy();
  assert.deepEqual(events, ['create:M7lc1UVf-VE', 'destroy:native']);
  assert.equal(router.adapter, null);
  assert.equal(router.activeRoute, null);
});
