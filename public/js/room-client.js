const DEFAULT_PERMISSIONS = Object.freeze({ guestPlaybackControl: false });
const PROTOCOL_VERSION = 1;
const WEBSOCKET_PROTOCOL = 'dreamstream-v1';
const CREDENTIAL_PROTOCOL_PREFIX = 'token.';
const MEDIA_SOURCE_CACHE_MS = 10 * 60 * 1000;

function randomId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function initialPlayback() {
  return {
    revision: 0,
    media: null,
    paused: true,
    anchorSeconds: 0,
    anchorServerMs: Date.now(),
    playbackRate: 1,
    changedBy: null,
    actionId: null,
  };
}

function currentPosition(playback, now = Date.now()) {
  if (!playback?.media || playback.paused) return Math.max(0, playback?.anchorSeconds || 0);
  return Math.max(0, (playback.anchorSeconds || 0)
    + Math.max(0, now - playback.anchorServerMs) / 1000 * (playback.playbackRate || 1));
}

export class RoomClient {
  constructor() {
    this.listeners = new Map();
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type)?.delete(handler);
  }

  onSnapshot(handler) { return this.on('snapshot', handler); }
  onPresence(handler) { return this.on('presence', handler); }
  onPlayback(handler) { return this.on('playback', handler); }
  onChat(handler) { return this.on('chat', handler); }
  onPermissions(handler) { return this.on('permissions', handler); }
  onConnection(handler) { return this.on('connection', handler); }

  emit(type, payload) {
    for (const handler of this.listeners.get(type) || []) handler(payload);
  }

  async join() { throw new Error('RoomClient.join() is not implemented'); }
  async sendPlayback() { throw new Error('RoomClient.sendPlayback() is not implemented'); }
  async sendChat() { throw new Error('RoomClient.sendChat() is not implemented'); }
  async updatePermissions() { throw new Error('RoomClient.updatePermissions() is not implemented'); }
  async resolveMedia() { return null; }
  async ping() { return { serverTime: Date.now() }; }
  close() {}
}

export class DemoRoomClient extends RoomClient {
  constructor() {
    super();
    const now = Date.now();
    this.clientId = null;
    this.nickname = null;
    this.roomId = 'DEMO99';
    this.state = {
      permissions: { ...DEFAULT_PERMISSIONS },
      playback: initialPlayback(),
      members: [
        { clientId: 'demo-pixelcat', nickname: 'PixelCat', role: 'guest' },
        { clientId: 'demo-cybermia', nickname: 'CyberMia', role: 'guest' },
      ],
      messages: [
        { id: 'demo-1', clientId: 'demo-pixelcat', nickname: 'PixelCat', body: 'Welcome to DreamStream 99!', serverTime: now - 150000 },
        { id: 'demo-2', clientId: 'demo-cybermia', nickname: 'CyberMia', body: 'Paste a YouTube URL to start watching.', serverTime: now - 90000 },
        { id: 'demo-3', clientId: 'demo-pixelcat', nickname: 'PixelCat', body: 'Local preview is active; production rooms use the VPS.', serverTime: now - 30000 },
      ],
    };
  }

  snapshot() {
    return clone({ roomId: this.roomId, serverTime: Date.now(), ...this.state });
  }

  async join({ roomId, nickname }) {
    this.roomId = roomId || this.roomId;
    this.nickname = String(nickname || 'Guest').trim().slice(0, 24) || 'Guest';
    this.clientId = randomId();
    this.state.members = this.state.members.filter((member) => member.clientId !== this.clientId);
    this.state.members.push({ clientId: this.clientId, nickname: this.nickname, role: 'owner' });
    const snapshot = this.snapshot();
    this.emit('connection', { state: 'connected', demo: true });
    this.emit('presence', clone(this.state.members));
    return { ok: true, clientId: this.clientId, role: 'owner', snapshot };
  }

  async sendPlayback(command) {
    if (!this.clientId) return { ok: false, error: 'Not joined' };
    const now = Date.now();
    const previous = this.state.playback;
    const next = { ...previous };
    const position = Math.max(0, Number(command.position ?? currentPosition(previous, now)) || 0);

    switch (command.action) {
      case 'load':
        if (!isValidMediaRef(command.media)) {
          return { ok: false, error: 'Invalid media' };
        }
        Object.assign(next, { media: clone(command.media), paused: true, anchorSeconds: position, playbackRate: 1 });
        break;
      case 'play':
        Object.assign(next, { paused: false, anchorSeconds: position });
        break;
      case 'pause':
      case 'end':
        Object.assign(next, { paused: true, anchorSeconds: position });
        break;
      case 'seek':
        next.anchorSeconds = position;
        break;
      case 'rate':
        Object.assign(next, { anchorSeconds: position, playbackRate: Number(command.rate) || 1 });
        break;
      default:
        return { ok: false, error: 'Unknown playback action' };
    }

    Object.assign(next, {
      revision: previous.revision + 1,
      anchorServerMs: now,
      changedBy: this.nickname,
      actionId: command.actionId || randomId(),
    });
    this.state.playback = next;
    this.emit('playback', { playback: clone(next), serverTime: now });
    return { ok: true, revision: next.revision };
  }

  async sendChat({ body }) {
    if (!this.clientId) return { ok: false, error: 'Not joined' };
    const text = String(body || '').trim().slice(0, 1000);
    if (!text) return { ok: false, error: 'Empty message' };
    const message = {
      id: randomId(),
      clientId: this.clientId,
      nickname: this.nickname,
      body: text,
      serverTime: Date.now(),
    };
    this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-100);
    this.emit('chat', clone(message));
    return { ok: true, id: message.id };
  }

  async updatePermissions(nextPermissions) {
    this.state.permissions = {
      guestPlaybackControl: Boolean(nextPermissions?.guestPlaybackControl),
    };
    this.emit('permissions', clone(this.state.permissions));
    return { ok: true, permissions: clone(this.state.permissions) };
  }

  async ping() {
    return { serverTime: Date.now() };
  }

  close() {
    this.emit('connection', { state: 'disconnected', demo: true });
  }
}

function isValidMediaRef(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return false;
  const keys = Object.keys(media).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'provider') return false;
  if (!isBoundedMediaString(media.provider, 64) || !isBoundedMediaString(media.id, 2048)) return false;
  return media.provider !== 'youtube' || /^[A-Za-z0-9_-]{11}$/.test(media.id);
}

function isBoundedMediaString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

/**
 * Native WebSocket transport for the production control service.
 * Frames use { version, type, requestId?, payload? }; responses use
 * { type: 'response', requestId, ok, payload? }.
 */
export class WebSocketRoomClient extends RoomClient {
  constructor({ apiUrl, websocketUrl = null, mediaUrl = null, fetchImpl, WebSocketImpl } = {}) {
    super();
    if (!apiUrl) throw new Error('WT_RUNTIME.apiUrl is required in websocket mode');
    this.apiUrl = normalizeRoomsApiUrl(apiUrl);
    this.websocketUrl = websocketUrl;
    this.mediaUrl = mediaUrl;
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;
    this.socket = null;
    this.connectPromise = null;
    this.connectReject = null;
    this.pending = new Map();
    this.manualClose = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.roomId = null;
    this.credential = null;
    this.credentialExpiresAt = null;
    this.credentialKind = null;
    this.lastJoin = null;
    this.mediaSourceCache = new Map();
    this.mediaSourcePending = new Map();
    this.mediaSourceGeneration = new Map();
  }

  async connect() {
    if (this.socket?.readyState === 1) return;
    if (this.connectPromise) return this.connectPromise;
    if (!this.WebSocketImpl) throw new Error('WebSocket is not available in this browser');
    if (!this.roomId || !this.credential) throw new Error('A room credential is required before connecting');

    this.manualClose = false;
    this.emit('connection', { state: 'connecting' });
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(
        buildRoomWebSocketUrl(this.websocketUrl || this.apiUrl, this.roomId),
        [WEBSOCKET_PROTOCOL, `${CREDENTIAL_PROTOCOL_PREFIX}${this.credential}`],
      );
      this.socket = socket;
      let opened = false;
      const fail = (error) => {
        if (opened) return;
        this.connectReject = null;
        reject(error instanceof Error ? error : new Error('WebSocket connection failed'));
      };
      this.connectReject = fail;
      socket.addEventListener('open', () => {
        if (socket !== this.socket) return;
        opened = true;
        this.connectReject = null;
        this.reconnectAttempts = 0;
        this.emit('connection', { state: 'connected' });
        resolve();
      }, { once: true });
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('close', (event) => {
        if (!opened) fail(new Error('WebSocket connection closed before it opened'));
        if (socket !== this.socket) return;
        this.socket = null;
        this.connectPromise = null;
        this.emit('connection', { state: 'disconnected' });
        this.rejectPending('WebSocket disconnected');
        this.clearMediaSources();
        if (event?.code === 4003 && this.credentialKind === 'guest') this.clearCredential();
        if (!this.manualClose) this.scheduleReconnect();
      });
    }).catch((error) => {
      this.connectPromise = null;
      throw error;
    });
    return this.connectPromise;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.lastJoin) return;
    const delayMs = Math.min(10000, 800 * (2 ** Math.min(this.reconnectAttempts, 4)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.prepareCredential(this.lastJoin);
        await this.connect();
      } catch {
        if (!this.manualClose) this.scheduleReconnect();
      }
    }, delayMs);
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message?.version !== PROTOCOL_VERSION) return;
    if (message.type === 'response' && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      pending.resolve(message.payload && typeof message.payload === 'object'
        ? { ...message, ...message.payload }
        : message);
      return;
    }
    const eventMap = {
      snapshot: 'snapshot',
      'presence:update': 'presence',
      'playback:state': 'playback',
      'chat:message': 'chat',
      'room:permissions': 'permissions',
    };
    const eventName = eventMap[message.type];
    if (eventName) this.emit(eventName, message.payload ?? message);
  }

  async request(type, payload) {
    await this.connect();
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`WebSocket request timed out: ${type}`));
      }, 10000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type, requestId, payload }));
    });
  }

  async join(payload) {
    const roomId = normalizeRoomId(payload?.roomId);
    const nickname = normalizeNickname(payload?.nickname);
    const token = normalizeOptionalCredential(payload?.token);
    const nextJoin = { roomId, nickname, token };

    if (this.roomId && this.roomId !== roomId) this.disconnectSocket('switching rooms');
    this.roomId = roomId;
    this.lastJoin = nextJoin;
    await this.prepareCredential(nextJoin);
    return this.request('room:join', {
      roomId,
      token: this.credential,
      nickname,
    });
  }

  async prepareCredential({ roomId, nickname, token }) {
    if (token) {
      if (this.credential !== token || this.credentialKind !== 'host') {
        this.disconnectSocket('credential changed');
        this.clearMediaSources();
      }
      this.credential = token;
      this.credentialExpiresAt = null;
      this.credentialKind = 'host';
      return;
    }

    const reusableGuestCredential = this.credentialKind === 'guest'
      && this.credential
      && this.roomId === roomId
      && (!this.credentialExpiresAt || this.credentialExpiresAt > Date.now() + 30_000);
    if (reusableGuestCredential) return;
    if (!this.fetchImpl) throw new Error('fetch is not available in this browser');

    this.disconnectSocket('refreshing room credential');
    this.clearMediaSources();
    const response = await this.fetchImpl(buildRoomHttpUrl(this.apiUrl, roomId, 'join'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    });
    const result = await readJsonResponse(response, 'Could not join the room');
    if (!response.ok || result?.ok === false) {
      throw responseError(result, 'Could not join the room', response.status);
    }
    if (typeof result?.roomToken !== 'string' || !result.roomToken) {
      throw new Error('The room service returned an invalid room credential');
    }
    this.credential = result.roomToken;
    this.credentialExpiresAt = Number.isFinite(result.expiresAt) ? result.expiresAt : null;
    this.credentialKind = 'guest';
  }

  sendPlayback(payload) { return this.request('playback:command', payload); }
  sendChat(payload) { return this.request('chat:send', payload); }
  updatePermissions(payload) { return this.request('room:permissions:update', payload); }
  ping(payload = {}) { return this.request('time:ping', payload); }

  async resolveMedia(media, { force = false, mediaUrl = this.mediaUrl } = {}) {
    if (!mediaUrl) return null;
    if (!this.roomId || !this.credential) throw new Error('Join the room before resolving media');
    if (!isValidMediaRef(media)) throw new Error('Cannot resolve invalid media');
    if (!this.fetchImpl) throw new Error('fetch is not available in this browser');

    const cacheKey = `${this.roomId}:${media.provider}:${media.id}`;
    const cached = this.mediaSourceCache.get(cacheKey);
    if (!force && cached?.expiresAt > Date.now()) return clone(cached.value);
    if (!force && this.mediaSourcePending.has(cacheKey)) return this.mediaSourcePending.get(cacheKey);

    const generation = (this.mediaSourceGeneration.get(cacheKey) || 0) + 1;
    this.mediaSourceGeneration.set(cacheKey, generation);
    const resolving = this.fetchMediaSource(media, mediaUrl).then((value) => {
      if (this.mediaSourceGeneration.get(cacheKey) === generation) {
        this.mediaSourceCache.set(cacheKey, {
          expiresAt: Date.now() + MEDIA_SOURCE_CACHE_MS,
          value,
        });
      }
      return clone(value);
    }).finally(() => {
      if (this.mediaSourcePending.get(cacheKey) === resolving) this.mediaSourcePending.delete(cacheKey);
    });
    this.mediaSourcePending.set(cacheKey, resolving);
    return resolving;
  }

  async fetchMediaSource(media, mediaUrl) {
    const grantResponse = await this.fetchImpl(buildRoomHttpUrl(this.apiUrl, this.roomId, 'media-grants'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.credential}` },
    });
    const grant = await readJsonResponse(grantResponse, 'Could not authorize media playback');
    if (!grantResponse.ok || grant?.ok === false) {
      throw responseError(grant, 'Could not authorize media playback', grantResponse.status);
    }
    if (typeof grant?.mediaGrant !== 'string' || !sameMedia(grant.media, media)) {
      throw new Error('The room service returned an invalid media grant');
    }

    const resolveUrl = buildMediaResolveUrl(mediaUrl);
    const resolveResponse = await this.fetchImpl(resolveUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grant.mediaGrant}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ media: grant.media }),
    });
    const resolved = await readJsonResponse(resolveResponse, 'Could not resolve the media stream');
    if (!resolveResponse.ok || resolved?.ok === false) {
      throw responseError(resolved, 'Could not resolve the media stream', resolveResponse.status);
    }
    if (!sameMedia(resolved?.media, media) || !Array.isArray(resolved?.streams)) {
      throw new Error('The media service returned an invalid response');
    }
    const stream = resolved.streams.find((candidate) => (
      candidate
      && typeof candidate === 'object'
      && candidate.delivery === 'progressive'
      && typeof candidate.relay_url === 'string'
      && candidate.relay_url.trim()
    ));
    if (!stream) throw new Error('No compatible progressive media stream is available');

    const playbackUrl = new URL(buildRelayPlaybackUrl(mediaUrl, stream.relay_url));
    if (playbackUrl.protocol !== 'https:' && playbackUrl.protocol !== 'http:') {
      throw new Error('The media service returned an invalid relay URL');
    }
    return {
      playbackUrl: playbackUrl.href,
      media: clone(resolved.media),
      metadata: normalizeMediaMetadata(resolved.metadata),
      stream: clone(stream),
    };
  }

  invalidateMedia(media) {
    if (!media || !this.roomId) return;
    this.mediaSourceCache.delete(`${this.roomId}:${media.provider}:${media.id}`);
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.lastJoin = null;
    this.disconnectSocket('client closed');
  }

  disconnectSocket(reason) {
    const socket = this.socket;
    this.connectReject?.(new Error(reason || 'WebSocket disconnected'));
    this.connectReject = null;
    this.rejectPending(reason || 'WebSocket disconnected');
    if (!socket) return;
    this.socket = null;
    this.connectPromise = null;
    try {
      socket.close(1000, reason);
    } catch {
      // A socket can already be closing when credentials rotate.
    }
  }

  clearCredential() {
    this.credential = null;
    this.credentialExpiresAt = null;
    this.credentialKind = null;
    this.clearMediaSources();
  }

  clearMediaSources() {
    this.mediaSourceCache.clear();
    this.mediaSourcePending.clear();
    this.mediaSourceGeneration.clear();
  }

  rejectPending(message) {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error(message));
    }
    this.pending.clear();
  }
}

export function buildRoomHttpUrl(apiUrl, roomId, action) {
  const url = new URL(normalizeRoomsApiUrl(apiUrl));
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(normalizeRoomId(roomId))}/${action}`;
  return url.href;
}

export function buildRoomWebSocketUrl(websocketOrApiUrl, roomId) {
  const template = String(websocketOrApiUrl || '');
  const encodedRoomId = encodeURIComponent(normalizeRoomId(roomId));
  const url = template.includes('{roomId}')
    ? new URL(template.replaceAll('{roomId}', encodedRoomId), globalThis.location?.href)
    : new URL(normalizeRoomsApiUrl(template));
  if (!template.includes('{roomId}')) {
    const pathname = url.pathname.replace(/\/$/, '');
    if (!pathname.endsWith('/ws')) url.pathname = `${pathname}/${encodedRoomId}/ws`;
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Invalid WebSocket endpoint');
  url.search = '';
  url.hash = '';
  return url.href;
}

export function normalizeRoomsApiUrl(apiUrl) {
  const url = new URL(normalizeEndpointUrl(apiUrl));
  if (!url.pathname || url.pathname === '/') url.pathname = '/api/rooms';
  return url.href;
}

export function buildMediaResolveUrl(mediaUrl) {
  const url = new URL(normalizeEndpointUrl(mediaUrl));
  if (!url.pathname.replace(/\/$/, '').endsWith('/resolve')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/resolve`;
  }
  return url.href;
}

export function buildRelayPlaybackUrl(mediaUrl, relayUrl) {
  const rawRelayUrl = String(relayUrl || '').trim();
  if (!rawRelayUrl) throw new Error('The media service returned an invalid relay URL');
  const base = new URL(normalizeEndpointUrl(mediaUrl));
  let absoluteRelayUrl = null;
  try {
    absoluteRelayUrl = new URL(rawRelayUrl);
  } catch {
    // Relative relay paths are resolved below against the public media endpoint.
  }
  if (absoluteRelayUrl) return validatePublicMediaUrl(absoluteRelayUrl, base);
  if (rawRelayUrl.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(rawRelayUrl)) {
    throw new Error('The media service returned an invalid relay URL');
  }

  const basePath = base.pathname.replace(/\/$/, '');
  const relativeRelayUrl = new URL(rawRelayUrl, 'https://relay.invalid/');
  const relayPath = relativeRelayUrl.pathname.startsWith('/')
    ? relativeRelayUrl.pathname
    : `/${relativeRelayUrl.pathname}`;
  base.pathname = basePath && basePath !== '/' && !relayPath.startsWith(`${basePath}/`)
    ? `${basePath}${relayPath}`
    : relayPath;
  base.search = relativeRelayUrl.search;
  base.hash = '';
  return validatePublicMediaUrl(base, new URL(normalizeEndpointUrl(mediaUrl)));
}

function validatePublicMediaUrl(url, mediaBase) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The media service returned an invalid relay URL');
  }
  if (url.username || url.password) {
    throw new Error('The media service returned an invalid relay URL');
  }
  const basePath = mediaBase.pathname.replace(/\/$/, '');
  const relayPrefix = basePath && basePath !== '/' ? `${basePath}/relay/` : '/relay/';
  if (url.origin !== mediaBase.origin || !url.pathname.startsWith(relayPrefix)) {
    throw new Error('The media service returned an invalid relay URL');
  }
  url.hash = '';
  return url.href;
}

function normalizeEndpointUrl(value) {
  const base = globalThis.location?.href || 'http://localhost/';
  const url = new URL(String(value || ''), base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('Endpoint must use HTTP(S) or WebSocket(S)');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(roomId)) throw new Error('Invalid room ID');
  return roomId;
}

function normalizeNickname(value) {
  const nickname = String(value || '').trim().slice(0, 24);
  if (!nickname) throw new Error('Nickname is required');
  return nickname;
}

function normalizeOptionalCredential(value) {
  const credential = typeof value === 'string' ? value.trim() : '';
  if (!credential) return null;
  if (credential.length < 20 || credential.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(credential)) {
    throw new Error('Invalid room credential');
  }
  return credential;
}

function sameMedia(left, right) {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function normalizeMediaMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return {
    title: typeof metadata.title === 'string' ? metadata.title : '',
    duration: Number.isFinite(metadata.duration) ? metadata.duration : null,
  };
}

async function readJsonResponse(response, fallbackMessage) {
  try {
    return await response.json();
  } catch {
    if (!response.ok) throw new Error(fallbackMessage);
    throw new Error('The service returned an invalid JSON response');
  }
}

function responseError(body, fallbackMessage, status) {
  const message = body?.error || body?.detail?.message;
  const error = new Error(typeof message === 'string' && message ? message : fallbackMessage);
  if (typeof body?.code === 'string') error.code = body.code;
  else if (typeof body?.detail?.code === 'string') error.code = body.detail.code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

export function createRoomClient(runtime = {}) {
  if ((runtime.mode || 'demo') === 'demo') return new DemoRoomClient();
  if (runtime.mode === 'websocket') return new WebSocketRoomClient(runtime);
  throw new Error(`Unsupported WT_RUNTIME mode: ${runtime.mode}`);
}
