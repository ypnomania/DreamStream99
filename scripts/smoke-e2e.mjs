import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const baseUrl = new URL(process.env.DREAMSTREAM_BASE_URL || 'https://dreamstream99.lucius7.dev');
const allowedOrigin = process.env.DREAMSTREAM_ORIGIN || 'https://ypnomania.github.io';
const mediaId = process.env.DREAMSTREAM_MEDIA_ID || 'dQw4w9WgXcQ';
const skipMedia = process.env.DREAMSTREAM_SKIP_MEDIA === '1';
const media = { provider: 'youtube', id: mediaId };

if (!/^https?:$/.test(baseUrl.protocol)) throw new Error('DREAMSTREAM_BASE_URL must use HTTP(S)');
if (!/^[A-Za-z0-9_-]{11}$/.test(mediaId)) throw new Error('DREAMSTREAM_MEDIA_ID is invalid');

async function main() {
  const summary = { baseUrl: baseUrl.origin, control: false, media: skipMedia ? 'skipped' : false };
  let host;
  let guest;

  try {
  const created = await jsonRequest('/api/rooms', { method: 'POST' });
  assert.match(created.roomId, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(typeof created.hostToken, 'string');

  const guestCredential = await jsonRequest(`/api/rooms/${created.roomId}/join`, {
    method: 'POST',
    body: { nickname: 'SmokeGuest' },
  });
  assert.equal(typeof guestCredential.roomToken, 'string');

  [host, guest] = await Promise.all([
    Peer.connect(baseUrl, created.roomId, created.hostToken, allowedOrigin),
    Peer.connect(baseUrl, created.roomId, guestCredential.roomToken, allowedOrigin),
  ]);
  await Promise.all([
    host.request('room:join', {
      roomId: created.roomId,
      token: created.hostToken,
      nickname: 'SmokeHost',
    }),
    guest.request('room:join', {
      roomId: created.roomId,
      token: guestCredential.roomToken,
      nickname: 'SmokeGuest',
    }),
  ]);

  const loaded = await host.request('playback:command', {
    action: 'load',
    actionId: crypto.randomUUID(),
    position: 0,
    media,
  });
  assert.equal(loaded.revision, 1);
  const guestPlayback = await guest.take((message) => message.type === 'playback:state');
  assert.deepEqual(guestPlayback.payload.playback.media, media);

  await host.request('room:permissions:update', { guestPlaybackControl: true });
  await guest.take((message) => message.type === 'room:permissions');
  const played = await guest.request('playback:command', {
    action: 'play',
    actionId: crypto.randomUUID(),
    position: 1,
  });
  assert.equal(played.revision, 2);
  await guest.request('chat:send', { body: 'production smoke check' });
  summary.control = true;

  if (!skipMedia) {
    const grant = await jsonRequest(`/api/rooms/${created.roomId}/media-grants`, {
      method: 'POST',
      authorization: created.hostToken,
    });
    assert.deepEqual(grant.media, media);
    assert.match(grant.mediaGrant, /^mg1\./);

    const resolvedResponse = await fetch(new URL('/media/resolve', baseUrl), {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${grant.mediaGrant}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ media }),
    });
    const resolvedText = await resolvedResponse.text();
    if (!resolvedResponse.ok) {
      throw new Error(`media resolve failed (${resolvedResponse.status}): ${safeError(resolvedText)}`);
    }
    assert.doesNotMatch(resolvedText, /googlevideo\.com|videoplayback/i);
    const resolved = JSON.parse(resolvedText);
    assert.deepEqual(resolved.media, media);
    const stream = resolved.streams?.find((candidate) => candidate?.delivery === 'progressive');
    assert.equal(typeof stream?.relay_url, 'string');
    const relayUrl = new URL(`/media${stream.relay_url}`, baseUrl);

    const head = await fetch(relayUrl, { method: 'HEAD', headers: { Origin: allowedOrigin } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    const range = await fetch(relayUrl, {
      headers: { Origin: allowedOrigin, Range: 'bytes=0-1023' },
    });
    assert.equal(range.status, 206);
    assert.match(range.headers.get('content-range') || '', /^bytes 0-/);
    const body = new Uint8Array(await range.arrayBuffer());
    assert.ok(body.byteLength > 0 && body.byteLength <= 1024);
    summary.media = {
      title: resolved.metadata?.title || null,
      bytes: body.byteLength,
      contentRange: range.headers.get('content-range'),
    };
  }
  } finally {
    host?.close();
    guest?.close();
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function jsonRequest(pathname, { method, body, authorization } = {}) {
  const headers = { Origin: allowedOrigin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${safeError(text)}`);
  return JSON.parse(text);
}

function safeError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.detail?.code || 'request failed';
  } catch {
    return 'non-JSON response';
  }
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = new Set();
    socket.on('message', (data) => this.push(JSON.parse(data.toString())));
  }

  static async connect(base, roomId, credential, origin) {
    const url = new URL(`/api/rooms/${roomId}/ws`, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, ['dreamstream-v1', `token.${credential}`], { origin });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Peer(socket);
  }

  request(type, payload) {
    const requestId = crypto.randomUUID();
    const waiting = this.take((message) => message.type === 'response' && message.requestId === requestId);
    this.socket.send(JSON.stringify({ version: 1, type, requestId, payload }));
    return waiting.then((message) => {
      if (!message.ok) throw new Error(`${type} failed: ${message.code || message.error}`);
      return message.payload;
    });
  }

  take(predicate, timeoutMs = 10_000) {
    const found = this.messages.findIndex(predicate);
    if (found >= 0) return Promise.resolve(this.messages.splice(found, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('WebSocket smoke check timed out'));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  push(message) {
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  close() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('WebSocket closed'));
    }
    this.waiters.clear();
    this.socket.close();
  }
}

await main();
