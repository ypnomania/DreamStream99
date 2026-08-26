import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DemoRoomClient,
  WebSocketRoomClient,
  buildMediaResolveUrl,
  buildRelayPlaybackUrl,
  buildRoomHttpUrl,
  buildRoomWebSocketUrl,
  createRoomClient,
  normalizeRoomsApiUrl,
} from '../public/js/room-client.js';

const ROOM_ID = 'ABCDEFGH';
const HOST_TOKEN = 'h'.repeat(43);
const GUEST_TOKEN = 'g'.repeat(43);
const MEDIA = { provider: 'youtube', id: 'dQw4w9WgXcQ' };

function snapshot(role = 'owner') {
  return {
    roomId: ROOM_ID,
    serverTime: Date.now(),
    permissions: { guestPlaybackControl: false },
    playback: {
      revision: 0,
      media: null,
      paused: true,
      anchorSeconds: 0,
      anchorServerMs: Date.now(),
      playbackRate: 1,
      changedBy: null,
      actionId: null,
    },
    members: [{ clientId: `${role}-client`, nickname: 'Tester', role }],
    messages: [],
  };
}

class FakeWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }

  addEventListener(type, handler, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ handler, once: Boolean(options.once) });
    this.listeners.set(type, entries);
  }

  dispatch(type, event) {
    const entries = [...(this.listeners.get(type) || [])];
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => !entry.once));
    for (const { handler } of entries) handler(event);
  }

  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    let payload;
    if (request.type === 'room:join') {
      const role = request.payload.token === HOST_TOKEN ? 'owner' : 'guest';
      payload = { clientId: `${role}-client`, role, snapshot: snapshot(role) };
    } else if (request.type === 'room:permissions:update') {
      payload = { permissions: request.payload };
    } else {
      payload = { revision: 1 };
    }
    queueMicrotask(() => this.dispatch('message', {
      data: JSON.stringify({
        version: 1,
        type: 'response',
        requestId: request.requestId,
        ok: true,
        payload,
      }),
    }));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    queueMicrotask(() => this.dispatch('close', { code, reason }));
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

test('createRoomClient defaults to the static demo transport', () => {
  assert.ok(createRoomClient() instanceof DemoRoomClient);
});

test('demo client joins with simulated members and messages', async () => {
  const client = new DemoRoomClient();
  const result = await client.join({ roomId: 'DEMO99', nickname: 'Tester' });

  assert.equal(result.ok, true);
  assert.equal(result.role, 'owner');
  assert.equal(result.snapshot.roomId, 'DEMO99');
  assert.equal(result.snapshot.members.at(-1).nickname, 'Tester');
  assert.ok(result.snapshot.messages.length >= 3);
});

test('demo playback and chat commands emit UI-compatible events', async () => {
  const client = new DemoRoomClient();
  await client.join({ roomId: 'DEMO99', nickname: 'Tester' });

  let playbackEvent;
  let chatEvent;
  client.onPlayback((payload) => { playbackEvent = payload; });
  client.onChat((payload) => { chatEvent = payload; });

  const playbackResult = await client.sendPlayback({
    action: 'load',
    actionId: 'test-action',
    media: { provider: 'youtube', id: 'dQw4w9WgXcQ' },
    position: 12,
  });
  const chatResult = await client.sendChat({ body: 'hello from pages' });

  assert.equal(playbackResult.ok, true);
  assert.deepEqual(playbackEvent.playback.media, { provider: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.equal(playbackEvent.playback.anchorSeconds, 12);
  assert.equal(chatResult.ok, true);
  assert.equal(chatEvent.body, 'hello from pages');
});

test('demo permissions use the control Worker guestPlaybackControl contract', async () => {
  const client = new DemoRoomClient();
  await client.join({ roomId: ROOM_ID, nickname: 'Tester' });

  const response = await client.updatePermissions({ guestPlaybackControl: true });

  assert.deepEqual(response.permissions, { guestPlaybackControl: true });
  assert.deepEqual(client.snapshot().permissions, { guestPlaybackControl: true });
});

test('endpoint helpers build per-room HTTP, WebSocket, and media resolve routes', () => {
  assert.equal(
    buildRoomHttpUrl('https://control.example/api/rooms/', ROOM_ID, 'join'),
    `https://control.example/api/rooms/${ROOM_ID}/join`,
  );
  assert.equal(normalizeRoomsApiUrl('https://control.example'), 'https://control.example/api/rooms');
  assert.equal(
    buildRoomWebSocketUrl('https://control.example/api/rooms', ROOM_ID),
    `wss://control.example/api/rooms/${ROOM_ID}/ws`,
  );
  assert.equal(
    buildRoomWebSocketUrl('wss://socket.example/rooms/{roomId}/ws', ROOM_ID),
    `wss://socket.example/rooms/${ROOM_ID}/ws`,
  );
  assert.equal(buildMediaResolveUrl('https://media.example/'), 'https://media.example/resolve');
  assert.equal(buildMediaResolveUrl('https://media.example/resolve'), 'https://media.example/resolve');
  assert.equal(
    buildRelayPlaybackUrl('https://dreamstream.example/media', '/relay/session'),
    'https://dreamstream.example/media/relay/session',
  );
  assert.equal(
    buildRelayPlaybackUrl('https://dreamstream.example/media', '/media/relay/session'),
    'https://dreamstream.example/media/relay/session',
  );
  assert.equal(
    buildRelayPlaybackUrl(
      'https://dreamstream.example/media',
      'https://dreamstream.example/media/relay/session',
    ),
    'https://dreamstream.example/media/relay/session',
  );
  assert.equal(
    buildRelayPlaybackUrl('https://dreamstream.example/media', '/relay/session?capability=rs1.test'),
    'https://dreamstream.example/media/relay/session?capability=rs1.test',
  );
  assert.throws(
    () => buildRelayPlaybackUrl('https://dreamstream.example/media', '//attacker.example/relay/session'),
    /invalid relay URL/i,
  );
  assert.throws(
    () => buildRelayPlaybackUrl('https://dreamstream.example/media', 'https://cdn.example/relay/session'),
    /invalid relay URL/i,
  );
  assert.throws(
    () => buildRelayPlaybackUrl('https://dreamstream.example/media', 'https://dreamstream.example/not-relay/session'),
    /invalid relay URL/i,
  );
  assert.throws(
    () => buildRelayPlaybackUrl('https://dreamstream.example/media', 'javascript:alert(1)'),
    /invalid relay URL/i,
  );
});

test('host join opens the room WebSocket with credential subprotocols and versioned frames', async (t) => {
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    fetchImpl: async (...args) => { fetchCalls.push(args); throw new Error('host must not exchange a token'); },
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());

  const result = await client.join({ roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' });

  assert.equal(result.ok, true);
  assert.equal(result.role, 'owner');
  assert.equal(fetchCalls.length, 0);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, `wss://control.example/api/rooms/${ROOM_ID}/ws`);
  assert.deepEqual(socket.protocols, ['dreamstream-v1', `token.${HOST_TOKEN}`]);
  assert.deepEqual(socket.sent[0], {
    version: 1,
    type: 'room:join',
    requestId: socket.sent[0].requestId,
    payload: { roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' },
  });
});

test('guest join exchanges a nickname for a roomToken before opening WebSocket', async (t) => {
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return jsonResponse({
        ok: true,
        roomId: ROOM_ID,
        roomToken: GUEST_TOKEN,
        clientId: 'guest-client',
        nickname: 'Viewer',
        expiresAt: Date.now() + 60_000,
      });
    },
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());

  const result = await client.join({ roomId: ROOM_ID, token: null, nickname: ' Viewer ' });

  assert.equal(result.role, 'guest');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `https://control.example/api/rooms/${ROOM_ID}/join`);
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.equal(fetchCalls[0].options.body, JSON.stringify({ nickname: 'Viewer' }));
  assert.deepEqual(FakeWebSocket.instances[0].protocols, ['dreamstream-v1', `token.${GUEST_TOKEN}`]);
});

test('media resolution exchanges the room credential for a grant and caches the relay capability', async (t) => {
  FakeWebSocket.instances = [];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/media-grants')) {
      return jsonResponse({ media: MEDIA, mediaGrant: 'signed-media-grant' });
    }
    if (url === 'https://media.example/resolve') {
      return jsonResponse({
        media: MEDIA,
        metadata: { title: 'Never Gonna Give You Up', duration: 213 },
        streams: [{ delivery: 'progressive', relay_url: '/relay/signed-session', mime_type: 'video/mp4' }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    mediaUrl: 'https://media.example',
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());
  await client.join({ roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' });

  const first = await client.resolveMedia(MEDIA);
  const second = await client.resolveMedia(MEDIA);

  assert.equal(first.playbackUrl, 'https://media.example/relay/signed-session');
  assert.equal(first.metadata.title, 'Never Gonna Give You Up');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://control.example/api/rooms/${ROOM_ID}/media-grants`);
  assert.deepEqual(calls[0].options.headers, { Authorization: `Bearer ${HOST_TOKEN}` });
  assert.equal(calls[1].url, 'https://media.example/resolve');
  assert.deepEqual(calls[1].options.headers, {
    Authorization: 'Bearer signed-media-grant',
    'Content-Type': 'application/json',
  });
  assert.equal(calls[1].options.body, JSON.stringify({ media: MEDIA }));

  await client.resolveMedia(MEDIA, { force: true });
  assert.equal(calls.length, 4);
});

test('a forced media refresh cannot be overwritten by an older pending resolve', async (t) => {
  FakeWebSocket.instances = [];
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    mediaUrl: 'https://media.example',
    fetchImpl: async () => { throw new Error('fetchMediaSource is stubbed'); },
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());
  await client.join({ roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' });
  const older = deferred();
  const fresher = deferred();
  let resolutions = 0;
  client.fetchMediaSource = async () => (++resolutions === 1 ? older.promise : fresher.promise);

  const pendingOlder = client.resolveMedia(MEDIA);
  const pendingFresh = client.resolveMedia(MEDIA, { force: true });
  fresher.resolve({ playbackUrl: 'https://media.example/relay/fresh', media: MEDIA });
  const fresh = await pendingFresh;
  older.resolve({ playbackUrl: 'https://media.example/relay/stale', media: MEDIA });
  await pendingOlder;

  const cached = await client.resolveMedia(MEDIA);
  assert.equal(fresh.playbackUrl, 'https://media.example/relay/fresh');
  assert.equal(cached.playbackUrl, 'https://media.example/relay/fresh');
  assert.equal(resolutions, 2);
});

test('media resolution rejects mismatched grants without exposing a relay URL', async (t) => {
  FakeWebSocket.instances = [];
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    mediaUrl: 'https://media.example',
    fetchImpl: async (url) => url.endsWith('/media-grants')
      ? jsonResponse({ media: { ...MEDIA, id: 'M7lc1UVf-VE' }, mediaGrant: 'wrong-media' })
      : jsonResponse({ media: MEDIA, streams: [] }),
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());
  await client.join({ roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' });

  await assert.rejects(client.resolveMedia(MEDIA), /invalid media grant/i);
});

test('media HTTP failures preserve status and error code for bounded app recovery', async (t) => {
  FakeWebSocket.instances = [];
  const client = new WebSocketRoomClient({
    apiUrl: 'https://control.example/api/rooms',
    mediaUrl: 'https://media.example',
    fetchImpl: async () => jsonResponse({
      ok: false,
      code: 'NOT_JOINED',
      error: 'Join the room first',
    }, 403),
    WebSocketImpl: FakeWebSocket,
  });
  t.after(() => client.close());
  await client.join({ roomId: ROOM_ID, token: HOST_TOKEN, nickname: 'Host' });

  await assert.rejects(client.resolveMedia(MEDIA), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'NOT_JOINED');
    return true;
  });
});
