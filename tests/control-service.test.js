import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  assertProductionConfiguration,
  createControlServer,
} from '../server/control-service.js';
import { MEDIA_GRANT_SIGNING_DOMAIN, signMediaGrant } from '../server/media-grant.js';

const ORIGIN = 'https://ypnomania.github.io';
const SECRET = 'node-control-media-grant-test-secret-v1';
const MEDIA = { provider: 'youtube', id: 'dQw4w9WgXcQ' };

test('Node media-grant signer matches the cross-language v1 vector', async () => {
  const vector = JSON.parse(await readFile(
    new URL('./fixtures/media-grant-v1.json', import.meta.url),
    'utf8',
  ));
  const result = signMediaGrant({ secret: vector.secretUtf8, ...vector.input });
  assert.equal(MEDIA_GRANT_SIGNING_DOMAIN, vector.signingDomainUtf8);
  assert.equal(result.token, vector.token);
  assert.deepEqual(result.claims, vector.claims);
});

test('production configuration requires one exact HTTPS origin and validates the shared secret', () => {
  assert.doesNotThrow(() => assertProductionConfiguration({
    allowedOrigin: ORIGIN,
    mediaGrantSecret: SECRET,
  }));
  assert.doesNotThrow(() => assertProductionConfiguration({
    allowedOrigin: 'https://watch.example.com:8443',
    mediaGrantSecret: SECRET,
  }));
  assert.throws(() => assertProductionConfiguration({
    allowedOrigin: 'https://watch.example.com/path',
    mediaGrantSecret: SECRET,
  }), /one exact HTTPS origin/);
  assert.throws(() => assertProductionConfiguration({
    allowedOrigin: 'http://watch.example.com',
    mediaGrantSecret: SECRET,
  }), /one exact HTTPS origin/);
  assert.throws(() => assertProductionConfiguration({
    allowedOrigin: ORIGIN,
    mediaGrantSecret: 'too-short',
  }), /32-4096 UTF-8 bytes/);
});

test('HTTP API enforces CORS, creates rooms, issues per-member guest tokens, and cleans idle rooms', async (t) => {
  const fixture = await startControl(t, { roomTtlMs: 1_000 });
  const blocked = await fetch(`${fixture.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);

  const health = await fetch(`${fixture.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const created = await createRoom(fixture.baseUrl);
  assert.match(created.roomId, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.match(created.hostToken, /^[A-Za-z0-9_-]{43}$/);

  const alice = await joinRoom(fixture.baseUrl, created.roomId, 'Alice');
  const bob = await joinRoom(fixture.baseUrl, created.roomId, 'Bob');
  assert.notEqual(alice.roomToken, bob.roomToken);
  assert.notEqual(alice.clientId, bob.clientId);
  assert.ok(alice.expiresAt > Date.now() + 11 * 60 * 60 * 1000);

  const room = fixture.control.rooms.get(created.roomId);
  room.emptyExpiresAt = Date.now() - 1;
  fixture.control.cleanupExpiredRooms();
  const expired = await fetch(`${fixture.baseUrl}/api/rooms/${created.roomId}/join`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Late' }),
  });
  assert.equal(expired.status, 404);
});

test('native WebSocket v1 distributes state, enforces permissions, reconnects, and issues media grants', async (t) => {
  const fixture = await startControl(t);
  const created = await createRoom(fixture.baseUrl);
  const guestSession = await joinRoom(fixture.baseUrl, created.roomId, 'Viewer');
  const host = await openSocket(t, fixture.wsBase, created.roomId, created.hostToken);
  const guest = await openSocket(t, fixture.wsBase, created.roomId, guestSession.roomToken);

  await joinSocket(host, created.roomId, created.hostToken, 'Host', 'host-join');
  await joinSocket(guest, created.roomId, guestSession.roomToken, 'Viewer', 'guest-join');

  guest.send(frame('playback:command', 'guest-load-denied', {
    action: 'load',
    actionId: crypto.randomUUID(),
    position: 0,
    media: MEDIA,
  }));
  assert.deepEqual(
    pick(await guest.takeResponse('guest-load-denied'), ['ok', 'code']),
    { ok: false, code: 'FORBIDDEN' },
  );

  const loadActionId = crypto.randomUUID();
  host.send(frame('playback:command', 'host-load', {
    action: 'load', actionId: loadActionId, position: 0, media: MEDIA,
  }));
  assert.equal((await host.takeResponse('host-load')).payload.revision, 1);
  assert.deepEqual((await guest.takeType('playback:state')).payload.playback.media, MEDIA);

  guest.send(frame('playback:command', 'guest-play-denied', {
    action: 'play', actionId: crypto.randomUUID(), position: 0,
  }));
  assert.equal((await guest.takeResponse('guest-play-denied')).code, 'FORBIDDEN');

  host.send(frame('room:permissions:update', 'allow-guests', { guestPlaybackControl: true }));
  assert.deepEqual(
    (await host.takeResponse('allow-guests')).payload.permissions,
    { guestPlaybackControl: true },
  );
  assert.deepEqual((await guest.takeType('room:permissions')).payload, { guestPlaybackControl: true });

  guest.send(frame('playback:command', 'guest-play', {
    action: 'play', actionId: crypto.randomUUID(), position: 3,
  }));
  assert.equal((await guest.takeResponse('guest-play')).payload.revision, 2);

  host.send(frame('playback:command', 'duplicate-load', {
    action: 'load', actionId: loadActionId, position: 0, media: MEDIA,
  }));
  assert.deepEqual(
    (await host.takeResponse('duplicate-load')).payload,
    { revision: 1, duplicate: true },
  );

  guest.send(frame('time:ping', 'ping-1', { clientTime: 12345 }));
  assert.equal((await guest.takeResponse('ping-1')).payload.clientTime, 12345);

  const grantResponse = await fetch(
    `${fixture.baseUrl}/api/rooms/${created.roomId}/media-grants`,
    { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${guestSession.roomToken}` } },
  );
  assert.equal(grantResponse.status, 200);
  const grant = await grantResponse.json();
  assert.deepEqual(grant.media, MEDIA);
  const claims = verifyGrant(grant.mediaGrant, SECRET);
  assert.equal(claims.roomId, created.roomId);
  assert.equal(claims.subject, guestSession.clientId);
  assert.equal(claims.role, 'guest');
  assert.equal(claims.exp - claims.iat, 120);

  const previousClosed = guest.takeClose();
  const replacement = await openSocket(t, fixture.wsBase, created.roomId, guestSession.roomToken);
  await joinSocket(
    replacement,
    created.roomId,
    guestSession.roomToken,
    'Viewer',
    'replacement-join',
  );
  assert.equal((await previousClosed).code, 4001);
});

test('WebSocket join token is bound to the credential used during upgrade', async (t) => {
  const fixture = await startControl(t);
  const created = await createRoom(fixture.baseUrl);
  const first = await joinRoom(fixture.baseUrl, created.roomId, 'First');
  const second = await joinRoom(fixture.baseUrl, created.roomId, 'Second');
  const socket = await openSocket(t, fixture.wsBase, created.roomId, first.roomToken);
  socket.send(frame('room:join', 'wrong-token', {
    roomId: created.roomId,
    token: second.roomToken,
    nickname: 'First',
  }));
  assert.equal((await socket.takeResponse('wrong-token')).code, 'UNAUTHORIZED');
  await joinSocket(socket, created.roomId, first.roomToken, 'First', 'right-token');
});

async function startControl(t, overrides = {}) {
  const control = createControlServer({
    allowedOrigin: ORIGIN,
    mediaGrantSecret: SECRET,
    cleanupIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    control.server.once('error', reject);
    control.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => control.close());
  const address = control.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { control, baseUrl, wsBase: `ws://127.0.0.1:${address.port}` };
}

async function createRoom(baseUrl) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function joinRoom(baseUrl, roomId, nickname) {
  const response = await fetch(`${baseUrl}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function openSocket(t, wsBase, roomId, credential) {
  const webSocket = new WebSocket(
    `${wsBase}/api/rooms/${roomId}/ws`,
    ['dreamstream-v1', `token.${credential}`],
    { origin: ORIGIN },
  );
  const inbox = new SocketInbox(webSocket);
  await new Promise((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  assert.equal(webSocket.protocol, 'dreamstream-v1');
  t.after(() => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, 'test complete');
  });
  return inbox;
}

async function joinSocket(socket, roomId, token, nickname, requestId) {
  socket.send(frame('room:join', requestId, { roomId, token, nickname }));
  const joined = await socket.takeResponse(requestId);
  assert.equal(joined.ok, true);
  assert.equal(joined.payload.snapshot.roomId, roomId);
  return joined;
}

function frame(type, requestId, payload) {
  return JSON.stringify({ version: 1, type, requestId, payload });
}

function verifyGrant(token, secret) {
  const [prefix, payload, signature, extra] = token.split('.');
  assert.equal(prefix, 'mg1');
  assert.equal(extra, undefined);
  const compact = `${prefix}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(MEDIA_GRANT_SIGNING_DOMAIN, 'utf8')
    .update(compact, 'utf8')
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  assert.equal(actual.length, expected.length);
  assert.equal(crypto.timingSafeEqual(actual, expected), true);
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

class SocketInbox {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.messages = [];
    this.waiters = [];
    this.closeEvent = null;
    this.closeWaiters = [];
    webSocket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) return this.messages.push(message);
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    });
    webSocket.on('close', (code, reason) => {
      this.closeEvent = { code, reason: reason.toString() };
      for (const waiter of this.closeWaiters.splice(0)) waiter(this.closeEvent);
    });
  }

  send(value) { this.webSocket.send(value); }
  takeResponse(requestId) { return this.take((message) => message.type === 'response' && message.requestId === requestId); }
  takeType(type) { return this.take((message) => message.type === type); }

  takeClose() {
    if (this.closeEvent) return Promise.resolve(this.closeEvent);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), 2_000);
      this.closeWaiters.push((event) => { clearTimeout(timeout); resolve(event); });
    });
  }

  take(predicate) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2_000);
      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }
}
