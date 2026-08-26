import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { applyPlaybackCommand, createInitialPlayback, normalizeChat, normalizeNickname } from './room-state.js';
import { MEDIA_GRANT_TTL_SECONDS, signMediaGrant, validateMediaGrantSecret } from './media-grant.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,2048}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_RATES = new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
const PROTOCOL_VERSION = 1;
const WEBSOCKET_PROTOCOL = 'dreamstream-v1';
const CREDENTIAL_PROTOCOL_PREFIX = 'token.';
const MAX_POSITION_SECONDS = 24 * 60 * 60;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_MESSAGES = 100;
const MAX_RECENT_ACTIONS = 256;
const MAX_CONNECTIONS_PER_ROOM = 256;
const MAX_GUEST_CREDENTIALS = 1024;
const GUEST_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const JOIN_DEADLINE_MS = 15_000;
const CHAT_COOLDOWN_MS = 750;
const RATE_WINDOW_MS = 10_000;
const MAX_FRAMES_PER_WINDOW = 120;
const MAX_CONTROL_COMMANDS_PER_WINDOW = 30;
const MAX_RATE_LIMIT_BUCKETS = 50_000;
const PRODUCTION_PAGES_ORIGIN = 'https://ypnomania.github.io';

class ProtocolError extends Error {
  constructor(code, message, requestId = null) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

class FixedWindowLimiter {
  constructor() {
    this.buckets = new Map();
  }

  take(scope, key, limit, windowMs, now = Date.now()) {
    const bucketKey = `${scope}:${key}`;
    const current = this.buckets.get(bucketKey);
    if (!current || current.expiresAt <= now) {
      if (!current && this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        this.prune(now);
        if (this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
          this.buckets.delete(this.buckets.keys().next().value);
        }
      }
      this.buckets.set(bucketKey, { count: 1, expiresAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
  }
}

export function createControlServer(options = {}) {
  const config = {
    allowedOrigin: options.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? PRODUCTION_PAGES_ORIGIN,
    mediaGrantSecret: options.mediaGrantSecret ?? process.env.MEDIA_GRANT_SECRET ?? '',
    maxRooms: positiveInteger(options.maxRooms ?? process.env.MAX_ROOMS, 10_000),
    roomTtlMs: positiveInteger(options.roomTtlMs, DEFAULT_ROOM_TTL_MS),
    cleanupIntervalMs: positiveInteger(options.cleanupIntervalMs, 60_000),
    heartbeatIntervalMs: positiveInteger(options.heartbeatIntervalMs, 30_000),
    trustProxy: options.trustProxy ?? 1,
  };
  const rooms = new Map();
  const socketStates = new WeakMap();
  const limiter = new FixedWindowLimiter();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');
    response.vary('Origin');
    if (request.path === '/healthz') return next();
    if (request.get('Origin') !== config.allowedOrigin) {
      return apiError(response, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed');
    }
    response.set('Access-Control-Allow-Origin', config.allowedOrigin);
    response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.set('Access-Control-Max-Age', '86400');
    if (request.method === 'OPTIONS') return response.status(204).end();
    return next();
  });
  app.use(express.json({ limit: '4kb', strict: true }));

  app.get('/healthz', (_request, response) => {
    const configured = isValidConfiguration(config);
    response.status(configured ? 200 : 503).json(configured
      ? { ok: true, now: Date.now(), uptimeSeconds: Math.floor(process.uptime()) }
      : { ok: false, code: 'CONFIGURATION_ERROR', error: 'Control service is not configured' });
  });

  app.post('/api/rooms', (request, response) => {
    if (!limiter.take('create', request.ip, 10, 60_000)) return rateLimited(response);
    cleanupExpiredRooms();
    if (rooms.size >= config.maxRooms) {
      return apiError(response, 503, 'ROOM_CAPACITY', 'Room capacity is temporarily exhausted');
    }
    const roomId = createUniqueRoomId(rooms);
    const hostToken = randomToken();
    const now = Date.now();
    rooms.set(roomId, {
      id: roomId,
      hostTokenHash: hashToken(hostToken),
      guestCredentials: new Map(),
      sockets: new Set(),
      connections: new Map(),
      permissions: { guestPlaybackControl: false },
      playback: createInitialPlaybackAt(now),
      messages: [],
      recentActions: new Map(),
      createdAt: now,
      emptyExpiresAt: now + config.roomTtlMs,
    });
    return response.status(201).json({ ok: true, roomId, hostToken });
  });

  app.post('/api/rooms/:roomId/join', (request, response) => {
    if (!limiter.take('join', request.ip, 60, 60_000)) return rateLimited(response);
    const roomId = normalizeRoomId(request.params.roomId);
    if (!roomId) return apiError(response, 400, 'INVALID_ROOM_ID', 'Invalid room ID');
    const room = activeRoom(roomId);
    if (!room) return apiError(response, 404, 'ROOM_NOT_FOUND', 'Room not found or expired');
    if (!isPlainObject(request.body) || Object.keys(request.body).some((key) => key !== 'nickname')) {
      return apiError(response, 400, 'INVALID_REQUEST', 'Request body must contain only nickname');
    }
    purgeGuestCredentials(room);
    while (room.guestCredentials.size >= MAX_GUEST_CREDENTIALS) {
      room.guestCredentials.delete(room.guestCredentials.keys().next().value);
    }
    const nickname = normalizeNickname(request.body.nickname);
    const clientId = crypto.randomUUID();
    const roomToken = randomToken();
    const expiresAt = Date.now() + GUEST_TOKEN_TTL_MS;
    room.guestCredentials.set(hashToken(roomToken), { clientId, expiresAt, nickname });
    return response.json({ ok: true, roomId, roomToken, clientId, nickname, expiresAt });
  });

  app.post('/api/rooms/:roomId/media-grants', (request, response) => {
    if (Object.keys(request.query).length > 0) {
      return apiError(
        response,
        400,
        'QUERY_CREDENTIAL_FORBIDDEN',
        'Query parameters are not accepted; credentials belong in Authorization',
      );
    }
    if (!limiter.take('media-ip', request.ip, 120, 60_000)) return rateLimited(response);
    const roomId = normalizeRoomId(request.params.roomId);
    if (!roomId) return apiError(response, 400, 'INVALID_ROOM_ID', 'Invalid room ID');
    const room = activeRoom(roomId);
    if (!room) return apiError(response, 404, 'ROOM_NOT_FOUND', 'Room not found or expired');
    const credential = extractBearerCredential(request.get('Authorization'));
    const identity = credential ? authenticateCredential(room, credential) : null;
    if (!identity) return apiError(response, 401, 'UNAUTHORIZED', 'Invalid or expired room credential');
    const online = identity.role === 'owner'
      ? [...room.connections.values()].some((state) => state.role === 'owner')
      : room.connections.has(identity.clientId);
    if (!online) return apiError(response, 403, 'NOT_JOINED', 'Join the room before requesting media');
    if (!room.playback.media) return apiError(response, 409, 'NO_MEDIA', 'No media is loaded');
    if (!limiter.take('media-member', `${room.id}:${identity.subject}`, 30, 60_000)) {
      return rateLimited(response);
    }
    let grant;
    try {
      grant = signMediaGrant({
        secret: config.mediaGrantSecret,
        roomId: room.id,
        subject: identity.subject,
        role: identity.role,
        media: room.playback.media,
      });
    } catch {
      return apiError(response, 503, 'CONFIGURATION_ERROR', 'Media authorization is unavailable');
    }
    return response.json({
      expiresAt: grant.expiresAt,
      media: { ...room.playback.media },
      mediaGrant: grant.token,
    });
  });

  app.use((request, response) => apiError(response, 404, 'NOT_FOUND', 'Not found'));
  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.too.large') {
      return apiError(response, 413, 'REQUEST_TOO_LARGE', 'Request body is too large');
    }
    if (error instanceof SyntaxError) {
      return apiError(response, 400, 'INVALID_JSON', 'Request body must be a JSON object');
    }
    console.error('Control HTTP request failed', error instanceof Error ? error.message : 'Unknown error');
    return apiError(response, 500, 'INTERNAL_ERROR', 'Internal error');
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols(protocols) {
      return protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false;
    },
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      if (request.headers.origin !== config.allowedOrigin) {
        return rejectUpgrade(socket, 403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed');
      }
      const url = new URL(request.url || '/', 'http://control.internal');
      const roomId = roomIdFromWebSocketUrl(url);
      if (!roomId) return rejectUpgrade(socket, 400, 'INVALID_ROOM_ID', 'Invalid room ID');
      if (!limiter.take('ws', webSocketClientIp(request), 120, 60_000)) {
        return rejectUpgrade(socket, 429, 'RATE_LIMITED', 'Too many requests');
      }
      const room = activeRoom(roomId);
      if (!room) return rejectUpgrade(socket, 404, 'ROOM_NOT_FOUND', 'Room not found or expired');
      if (room.sockets.size >= MAX_CONNECTIONS_PER_ROOM) {
        return rejectUpgrade(socket, 429, 'ROOM_FULL', 'Room is full');
      }
      const credential = extractWebSocketCredential(request.headers['sec-websocket-protocol']);
      const identity = credential ? authenticateCredential(room, credential) : null;
      if (!identity) return rejectUpgrade(socket, 401, 'UNAUTHORIZED', 'Invalid room credential');
      request.dreamStreamAuth = {
        room,
        identity,
        credentialHash: hashToken(credential),
      };
      return wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
    } catch (error) {
      console.error('WebSocket upgrade failed', error instanceof Error ? error.message : 'Unknown error');
      return rejectUpgrade(socket, 500, 'INTERNAL_ERROR', 'WebSocket upgrade failed');
    }
  });

  wss.on('connection', (webSocket, request) => {
    const auth = request.dreamStreamAuth;
    if (!auth) return webSocket.close(1011, 'Missing connection state');
    const now = Date.now();
    const state = {
      webSocket,
      room: auth.room,
      clientId: auth.identity.role === 'owner' ? crypto.randomUUID() : auth.identity.clientId,
      role: auth.identity.role,
      subject: auth.identity.subject,
      nickname: auth.identity.role === 'owner' ? 'Host' : 'Guest',
      credentialHash: auth.credentialHash,
      tokenExpiresAt: auth.identity.expiresAt,
      joined: false,
      joinedAt: 0,
      lastChatAt: 0,
      frameWindowAt: now,
      frameCount: 0,
      controlWindowAt: now,
      controlCount: 0,
      isAlive: true,
      joinTimer: null,
      tokenTimer: null,
    };
    socketStates.set(webSocket, state);
    state.room.sockets.add(webSocket);
    state.joinTimer = setTimeout(() => webSocket.close(4008, 'Room join timed out'), JOIN_DEADLINE_MS);
    state.joinTimer.unref?.();
    if (state.tokenExpiresAt !== null) {
      state.tokenTimer = setTimeout(
        () => webSocket.close(4003, 'Room token expired'),
        Math.max(1, state.tokenExpiresAt - Date.now()),
      );
      state.tokenTimer.unref?.();
    }

    webSocket.on('pong', () => { state.isAlive = true; });
    webSocket.on('error', () => {});
    webSocket.on('message', (data, isBinary) => handleWebSocketMessage(state, data, isBinary));
    webSocket.on('close', () => removeSocket(state));
  });

  function handleWebSocketMessage(state, data, isBinary) {
    const now = Date.now();
    if (state.tokenExpiresAt !== null && state.tokenExpiresAt <= now) {
      state.webSocket.close(4003, 'Room token expired');
      return;
    }
    if (!consumeWindow(state, 'frameWindowAt', 'frameCount', MAX_FRAMES_PER_WINDOW, now)) {
      state.webSocket.close(4008, 'Message rate limit exceeded');
      return;
    }
    if (isBinary) {
      sendError(state.webSocket, fallbackRequestId(), 'INVALID_MESSAGE', 'Binary frames are not supported');
      return;
    }

    let message;
    try {
      message = parseClientMessage(data.toString());
    } catch (error) {
      const requestId = error instanceof ProtocolError && error.requestId
        ? error.requestId
        : extractRequestId(data.toString());
      sendError(
        state.webSocket,
        requestId,
        error instanceof ProtocolError ? error.code : 'INVALID_MESSAGE',
        'Invalid WebSocket message',
      );
      return;
    }
    if (activeRoom(state.room.id) !== state.room) {
      sendError(state.webSocket, message.requestId, 'ROOM_EXPIRED', 'The room has expired');
      state.webSocket.close(4004, 'Room expired');
      return;
    }

    try {
      if (message.type === 'room:join') return handleJoin(state, message);
      if (!state.joined) {
        return sendError(state.webSocket, message.requestId, 'NOT_JOINED', 'Join the room first');
      }
      if (message.type === 'playback:command') return handlePlayback(state, message, now);
      if (message.type === 'room:permissions:update') return handlePermissions(state, message, now);
      if (message.type === 'chat:send') return handleChat(state, message, now);
      return sendSuccess(state.webSocket, message.requestId, {
        clientTime: message.payload.clientTime,
        serverTime: now,
      });
    } catch (error) {
      console.error('WebSocket message failed', error instanceof Error ? error.message : 'Unknown error');
      return sendError(state.webSocket, message.requestId, 'INTERNAL_ERROR', 'Internal room error');
    }
  }

  function handleJoin(state, message) {
    if (state.joined) return sendError(state.webSocket, message.requestId, 'CONFLICT', 'Already joined');
    if (hashToken(message.payload.token) !== state.credentialHash) {
      return sendError(state.webSocket, message.requestId, 'UNAUTHORIZED', 'Join credential mismatch');
    }
    if (message.payload.roomId !== state.room.id) {
      return sendError(state.webSocket, message.requestId, 'ROOM_NOT_FOUND', 'Room ID does not match');
    }
    const existing = state.room.connections.get(state.clientId);
    if (existing && existing !== state) {
      existing.joined = false;
      existing.webSocket.close(4001, 'Replaced by reconnect');
    }
    clearTimeout(state.joinTimer);
    state.joinTimer = null;
    state.nickname = normalizeNickname(message.payload.nickname);
    state.joined = true;
    state.joinedAt = Date.now();
    state.room.connections.set(state.clientId, state);
    state.room.emptyExpiresAt = null;
    sendSuccess(state.webSocket, message.requestId, {
      clientId: state.clientId,
      role: state.role,
      snapshot: snapshot(state.room),
    });
    broadcastPresence(state.room);
  }

  function handlePlayback(state, message, now) {
    if (!consumeWindow(state, 'controlWindowAt', 'controlCount', MAX_CONTROL_COMMANDS_PER_WINDOW, now)) {
      return sendError(state.webSocket, message.requestId, 'RATE_LIMITED', 'Too many control commands');
    }
    const command = message.payload;
    const ownerOnly = command.action === 'load';
    if (state.role !== 'owner' && (ownerOnly || !state.room.permissions.guestPlaybackControl)) {
      return sendError(state.webSocket, message.requestId, 'FORBIDDEN', 'Playback command is not permitted');
    }
    if (command.action !== 'load' && !state.room.playback.media) {
      return sendError(state.webSocket, message.requestId, 'CONFLICT', 'No media is loaded');
    }
    const previousRevision = state.room.recentActions.get(command.actionId);
    if (previousRevision !== undefined) {
      return sendSuccess(state.webSocket, message.requestId, { revision: previousRevision, duplicate: true });
    }
    state.room.playback = applyPlaybackCommand(state.room.playback, command, state, now);
    state.room.recentActions.set(command.actionId, state.room.playback.revision);
    while (state.room.recentActions.size > MAX_RECENT_ACTIONS) {
      state.room.recentActions.delete(state.room.recentActions.keys().next().value);
    }
    broadcast(state.room, {
      version: PROTOCOL_VERSION,
      type: 'playback:state',
      payload: { playback: state.room.playback, serverTime: Date.now() },
    });
    return sendSuccess(state.webSocket, message.requestId, { revision: state.room.playback.revision });
  }

  function handlePermissions(state, message, now) {
    if (!consumeWindow(state, 'controlWindowAt', 'controlCount', MAX_CONTROL_COMMANDS_PER_WINDOW, now)) {
      return sendError(state.webSocket, message.requestId, 'RATE_LIMITED', 'Too many control commands');
    }
    if (state.role !== 'owner') {
      return sendError(state.webSocket, message.requestId, 'FORBIDDEN', 'Only the host can change permissions');
    }
    state.room.permissions = { guestPlaybackControl: message.payload.guestPlaybackControl };
    broadcast(state.room, {
      version: PROTOCOL_VERSION,
      type: 'room:permissions',
      payload: { ...state.room.permissions },
    });
    return sendSuccess(state.webSocket, message.requestId, {
      permissions: { ...state.room.permissions },
    });
  }

  function handleChat(state, message, now) {
    if (now - state.lastChatAt < CHAT_COOLDOWN_MS) {
      return sendError(state.webSocket, message.requestId, 'RATE_LIMITED', 'Please wait before chatting');
    }
    state.lastChatAt = now;
    const chat = {
      id: crypto.randomUUID(),
      clientId: state.clientId,
      nickname: state.nickname,
      body: normalizeChat(message.payload.body),
      serverTime: now,
    };
    state.room.messages.push(chat);
    if (state.room.messages.length > MAX_MESSAGES) {
      state.room.messages.splice(0, state.room.messages.length - MAX_MESSAGES);
    }
    broadcast(state.room, { version: PROTOCOL_VERSION, type: 'chat:message', payload: chat });
    return sendSuccess(state.webSocket, message.requestId, { id: chat.id });
  }

  function removeSocket(state) {
    clearTimeout(state.joinTimer);
    clearTimeout(state.tokenTimer);
    state.room.sockets.delete(state.webSocket);
    if (state.joined && state.room.connections.get(state.clientId) === state) {
      state.room.connections.delete(state.clientId);
      state.joined = false;
      broadcastPresence(state.room);
    }
    if (state.room.connections.size === 0 && state.room.emptyExpiresAt === null) {
      state.room.emptyExpiresAt = Date.now() + config.roomTtlMs;
    }
  }

  function broadcastPresence(room) {
    broadcast(room, {
      version: PROTOCOL_VERSION,
      type: 'presence:update',
      payload: publicMembers(room),
    });
  }

  function cleanupExpiredRooms(now = Date.now()) {
    limiter.prune(now);
    for (const room of rooms.values()) {
      purgeGuestCredentials(room, now);
      if (room.connections.size === 0 && room.emptyExpiresAt !== null && room.emptyExpiresAt <= now) {
        destroyRoom(room);
      }
    }
  }

  function destroyRoom(room) {
    rooms.delete(room.id);
    for (const webSocket of room.sockets) webSocket.close(4004, 'Room expired');
    room.sockets.clear();
    room.connections.clear();
    room.guestCredentials.clear();
  }

  function activeRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    if (room.connections.size === 0 && room.emptyExpiresAt !== null && room.emptyExpiresAt <= Date.now()) {
      destroyRoom(room);
      return null;
    }
    return room;
  }

  const cleanupTimer = setInterval(cleanupExpiredRooms, config.cleanupIntervalMs);
  cleanupTimer.unref();
  const heartbeatTimer = setInterval(() => {
    for (const webSocket of wss.clients) {
      const state = socketStates.get(webSocket);
      if (!state) continue;
      if (!state.isAlive) {
        webSocket.terminate();
        continue;
      }
      state.isAlive = false;
      webSocket.ping();
    }
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  async function close() {
    clearInterval(cleanupTimer);
    clearInterval(heartbeatTimer);
    for (const webSocket of wss.clients) webSocket.terminate();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
  }

  return { app, server, wss, rooms, config, close, cleanupExpiredRooms };
}

export function assertProductionConfiguration({ allowedOrigin, mediaGrantSecret }) {
  if (!isHttpsOrigin(allowedOrigin)) throw new Error('ALLOWED_ORIGIN must be one exact HTTPS origin');
  validateMediaGrantSecret(mediaGrantSecret);
}

function isValidConfiguration(config) {
  try {
    assertProductionConfiguration(config);
    return true;
  } catch {
    return false;
  }
}

function isHttpsOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && url.pathname === '/';
  } catch {
    return false;
  }
}

function createUniqueRoomId(rooms) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const roomId = [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
    if (!rooms.has(roomId)) return roomId;
  }
  throw new Error('Could not allocate a room ID');
}

function createInitialPlaybackAt(now) {
  return { ...createInitialPlayback(), anchorServerMs: now };
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('base64url');
}

function normalizeRoomId(value) {
  if (typeof value !== 'string') return null;
  const roomId = value.toUpperCase();
  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

function purgeGuestCredentials(room, now = Date.now()) {
  for (const [hash, credential] of room.guestCredentials) {
    if (credential.expiresAt <= now) room.guestCredentials.delete(hash);
  }
}

function authenticateCredential(room, token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const tokenHash = hashToken(token);
  if (safeHashEqual(tokenHash, room.hostTokenHash)) {
    return { role: 'owner', clientId: null, subject: 'host', expiresAt: null };
  }
  purgeGuestCredentials(room);
  const guest = room.guestCredentials.get(tokenHash);
  return guest
    ? { role: 'guest', clientId: guest.clientId, subject: guest.clientId, expiresAt: guest.expiresAt }
    : null;
}

function safeHashEqual(left, right) {
  try {
    const leftBytes = Buffer.from(left, 'base64url');
    const rightBytes = Buffer.from(right, 'base64url');
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function extractBearerCredential(value) {
  if (typeof value !== 'string') return null;
  return /^Bearer ([A-Za-z0-9._~-]{20,2048})$/i.exec(value)?.[1] ?? null;
}

function extractWebSocketCredential(value) {
  if (typeof value !== 'string') return null;
  const protocols = value.split(',').map((protocol) => protocol.trim());
  if (!protocols.includes(WEBSOCKET_PROTOCOL)) return null;
  const credentials = protocols.filter((protocol) => protocol.startsWith(CREDENTIAL_PROTOCOL_PREFIX));
  if (credentials.length !== 1) return null;
  const credential = credentials[0].slice(CREDENTIAL_PROTOCOL_PREFIX.length);
  return TOKEN_PATTERN.test(credential) ? credential : null;
}

function roomIdFromWebSocketUrl(url) {
  const match = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
  if (match) {
    try { return normalizeRoomId(decodeURIComponent(match[1])); } catch { return null; }
  }
  return null;
}

function publicMembers(room) {
  return [...room.connections.values()].map((state) => ({
    clientId: state.clientId,
    nickname: state.nickname,
    role: state.role,
  }));
}

function snapshot(room) {
  return {
    roomId: room.id,
    serverTime: Date.now(),
    permissions: { ...room.permissions },
    playback: { ...room.playback, media: room.playback.media ? { ...room.playback.media } : null },
    members: publicMembers(room),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

function broadcast(room, message) {
  const serialized = JSON.stringify(message);
  for (const state of room.connections.values()) {
    if (state.webSocket.readyState === WebSocket.OPEN) state.webSocket.send(serialized);
  }
}

function sendSuccess(webSocket, requestId, payload) {
  if (webSocket.readyState !== WebSocket.OPEN) return;
  webSocket.send(JSON.stringify({
    version: PROTOCOL_VERSION,
    type: 'response',
    requestId,
    ok: true,
    payload,
  }));
}

function sendError(webSocket, requestId, code, error) {
  if (webSocket.readyState !== WebSocket.OPEN) return;
  webSocket.send(JSON.stringify({
    version: PROTOCOL_VERSION,
    type: 'response',
    requestId,
    ok: false,
    code,
    error,
  }));
}

function consumeWindow(state, startedKey, countKey, limit, now) {
  if (now - state[startedKey] >= RATE_WINDOW_MS) {
    state[startedKey] = now;
    state[countKey] = 1;
    return true;
  }
  state[countKey] += 1;
  return state[countKey] <= limit;
}

function parseClientMessage(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError('INVALID_MESSAGE', 'Frame is too large');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError('INVALID_MESSAGE', 'Invalid JSON'); }
  const requestId = isPlainObject(value) && REQUEST_ID_PATTERN.test(value.requestId || '')
    ? value.requestId
    : null;
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'type', 'requestId', 'payload'])) {
    throw new ProtocolError('INVALID_MESSAGE', 'Invalid envelope', requestId);
  }
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_VERSION', 'Unsupported protocol version', requestId);
  }
  if (!requestId) throw new ProtocolError('INVALID_MESSAGE', 'Invalid request ID');
  if (!isPlainObject(value.payload)) throw new ProtocolError('INVALID_MESSAGE', 'Invalid payload', requestId);
  switch (value.type) {
    case 'room:join':
      parseJoinPayload(value.payload, requestId);
      break;
    case 'playback:command':
      parsePlaybackPayload(value.payload, requestId);
      break;
    case 'room:permissions:update':
      if (!hasExactKeys(value.payload, ['guestPlaybackControl']) || typeof value.payload.guestPlaybackControl !== 'boolean') {
        throw new ProtocolError('INVALID_MESSAGE', 'Invalid permissions', requestId);
      }
      break;
    case 'chat:send':
      if (
        !hasExactKeys(value.payload, ['body'])
        || typeof value.payload.body !== 'string'
        || value.payload.body.trim() !== value.payload.body
        || value.payload.body.length < 1
        || [...value.payload.body].length > 1000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.payload.body)
      ) throw new ProtocolError('INVALID_MESSAGE', 'Invalid chat body', requestId);
      break;
    case 'time:ping':
      if (
        !hasExactKeys(value.payload, ['clientTime'])
        || !Number.isSafeInteger(value.payload.clientTime)
        || value.payload.clientTime < 0
      ) throw new ProtocolError('INVALID_MESSAGE', 'Invalid client time', requestId);
      break;
    default:
      throw new ProtocolError('INVALID_MESSAGE', 'Unknown message type', requestId);
  }
  return value;
}

function parseJoinPayload(payload, requestId) {
  if (
    !hasExactKeys(payload, ['roomId', 'token', 'nickname'])
    || !ROOM_ID_PATTERN.test(payload.roomId)
    || typeof payload.token !== 'string'
    || !TOKEN_PATTERN.test(payload.token)
    || typeof payload.nickname !== 'string'
    || payload.nickname.trim() !== payload.nickname
    || payload.nickname.length < 1
    || [...payload.nickname].length > 24
    || /[\u0000-\u001f\u007f]/u.test(payload.nickname)
  ) throw new ProtocolError('INVALID_MESSAGE', 'Invalid join payload', requestId);
}

function parsePlaybackPayload(payload, requestId) {
  const action = payload.action;
  const allowed = {
    load: ['action', 'actionId', 'position', 'media'],
    play: ['action', 'actionId', 'position'],
    pause: ['action', 'actionId', 'position'],
    seek: null,
    rate: ['action', 'actionId', 'position', 'rate'],
    end: ['action', 'actionId', 'position'],
  }[action];
  const validShape = action === 'seek'
    ? hasOneExactKeySet(payload, [
      ['action', 'actionId', 'position'],
      ['action', 'actionId', 'position', 'paused'],
    ])
    : Boolean(allowed && hasExactKeys(payload, allowed));
  if (!validShape) {
    throw new ProtocolError('INVALID_MESSAGE', 'Invalid playback command', requestId);
  }
  if (
    !UUID_PATTERN.test(payload.actionId || '')
    || typeof payload.position !== 'number'
    || !Number.isFinite(payload.position)
    || payload.position < 0
    || payload.position > MAX_POSITION_SECONDS
  ) throw new ProtocolError('INVALID_MESSAGE', 'Invalid playback command', requestId);
  if (action === 'load' && (
    !isPlainObject(payload.media)
    || !hasExactKeys(payload.media, ['provider', 'id'])
    || payload.media.provider !== 'youtube'
    || !YOUTUBE_ID_PATTERN.test(payload.media.id || '')
  )) throw new ProtocolError('INVALID_MESSAGE', 'Invalid media', requestId);
  if (action === 'seek' && payload.paused !== undefined && typeof payload.paused !== 'boolean') {
    throw new ProtocolError('INVALID_MESSAGE', 'Invalid seek state', requestId);
  }
  if (action === 'rate' && !ALLOWED_RATES.has(payload.rate)) {
    throw new ProtocolError('INVALID_MESSAGE', 'Invalid playback rate', requestId);
  }
}

function extractRequestId(raw) {
  try {
    const value = JSON.parse(raw);
    if (REQUEST_ID_PATTERN.test(value?.requestId || '')) return value.requestId;
  } catch {}
  return fallbackRequestId();
}

function fallbackRequestId() {
  return `error-${crypto.randomUUID()}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOneExactKeySet(value, keySets) {
  return keySets.some((keys) => hasExactKeys(value, keys));
}

function webSocketClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : '';
  return first && first.length <= 64 ? first : request.socket.remoteAddress || 'unknown';
}

function apiError(response, status, code, error) {
  return response.status(status).json({ ok: false, code, error });
}

function rateLimited(response) {
  response.set('Retry-After', '60');
  return apiError(response, 429, 'RATE_LIMITED', 'Too many requests');
}

function rejectUpgrade(socket, status, code, error) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ ok: false, code, error });
  const reason = http.STATUS_CODES[status] || 'Error';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: application/json; charset=utf-8\r\n'
    + 'Cache-Control: no-store\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export { MEDIA_GRANT_TTL_SECONDS };
