import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import {
  applyPlaybackCommand,
  isValidRoomId,
  normalizeChat,
  normalizeNickname,
} from './room-state.js';
import {
  authenticateRoomToken,
  canChat,
  canControl,
  createRoomRecord,
  getActionRevision,
  rememberAction,
  touchRoom,
} from './rooms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const roomAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.post('/api/rooms', (_req, res) => {
  const id = createUniqueRoomId();
  const ownerToken = crypto.randomBytes(16).toString('base64url');
  const guestToken = crypto.randomBytes(16).toString('base64url');
  rooms.set(id, createRoomRecord({ id, ownerToken, guestToken }));
  res.status(201).set('Cache-Control', 'no-store').json({ roomId: id, ownerToken, guestToken });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, now: Date.now() }));
app.use(express.static(path.join(rootDir, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
  maxHttpBufferSize: 1e6,
});

function createUniqueRoomId() {
  do {
    const bytes = crypto.randomBytes(6);
    const roomId = [...bytes].map((byte) => roomAlphabet[byte % roomAlphabet.length]).join('');
    if (!rooms.has(roomId)) return roomId;
  } while (true);
}

function publicMembers(room) {
  return [...room.members.values()].map(({ clientId, nickname, role }) => ({
    clientId,
    nickname,
    role,
  }));
}

function snapshot(room) {
  return {
    roomId: room.id,
    serverTime: Date.now(),
    permissions: { ...room.permissions },
    playback: room.playback,
    members: publicMembers(room),
    messages: room.messages.slice(-100),
  };
}

function broadcastPresence(room) {
  io.to(room.id).emit('presence:update', publicMembers(room));
}

function broadcastPlayback(room) {
  io.to(room.id).emit('playback:state', { playback: room.playback, serverTime: Date.now() });
}

function addChat(room, actor, body) {
  const text = normalizeChat(body);
  if (!text) return null;
  const message = {
    id: crypto.randomUUID(),
    clientId: actor.clientId,
    nickname: actor.nickname,
    body: text,
    serverTime: Date.now(),
  };
  room.messages.push(message);
  if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);
  touchRoom(room);
  return message;
}

function leaveClient(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.members.delete(clientId);
  touchRoom(room);
  broadcastPresence(room);
}

io.on('connection', (socket) => {
  let session = null;

  socket.on('room:join', (payload, ack = () => {}) => {
    try {
      const roomId = String(payload?.roomId || '').toUpperCase();
      if (!isValidRoomId(roomId)) throw new Error('Room IDs must contain 4-12 letters or numbers');
      const room = rooms.get(roomId);
      const role = authenticateRoomToken(room, payload?.token);
      if (!room || !role || room.expiresAt <= Date.now()) {
        throw new Error('The room does not exist, has expired, or the invitation token is invalid');
      }

      if (session) {
        leaveClient(session.roomId, session.actor.clientId);
        socket.leave(session.roomId);
      }

      const actor = {
        clientId: crypto.randomUUID(),
        nickname: normalizeNickname(payload?.nickname),
        role,
      };
      session = { roomId, actor };
      socket.join(roomId);
      room.members.set(actor.clientId, actor);
      touchRoom(room);

      ack({ ok: true, clientId: actor.clientId, role, snapshot: snapshot(room) });
      broadcastPresence(room);
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on('playback:command', (command, ack = () => {}) => {
    try {
      if (!session) throw new Error('Not joined');
      const room = rooms.get(session.roomId);
      if (!room) throw new Error('Room expired');
      if (!canControl(room, session.actor.role)) throw new Error('You do not have permission to control playback');

      const previousRevision = getActionRevision(room, command?.actionId);
      if (previousRevision !== undefined) {
        return ack({ ok: true, duplicate: true, revision: previousRevision });
      }

      room.playback = applyPlaybackCommand(room.playback, command || {}, session.actor, Date.now());
      rememberAction(room, room.playback.actionId, room.playback.revision);
      touchRoom(room);
      broadcastPlayback(room);
      ack({ ok: true, revision: room.playback.revision });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on('room:permissions:update', (payload, ack = () => {}) => {
    try {
      if (!session) throw new Error('Not joined');
      const room = rooms.get(session.roomId);
      if (!room) throw new Error('Room expired');
      if (session.actor.role !== 'owner') throw new Error('Only the host can change permissions');
      room.permissions = {
        guestControl: Boolean(payload?.guestControl),
        guestChat: Boolean(payload?.guestChat),
      };
      touchRoom(room);
      io.to(room.id).emit('room:permissions', { ...room.permissions });
      ack({ ok: true, permissions: { ...room.permissions } });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on('chat:send', (payload, ack = () => {}) => {
    if (!session) return ack({ ok: false, error: 'Not joined' });
    const room = rooms.get(session.roomId);
    if (!room) return ack({ ok: false, error: 'Room expired' });
    if (!canChat(room, session.actor.role)) return ack({ ok: false, error: 'You do not have permission to send chat messages' });
    const message = addChat(room, session.actor, payload?.body);
    if (!message) return ack({ ok: false, error: 'Empty message' });
    io.to(room.id).emit('chat:message', message);
    ack({ ok: true, id: message.id });
  });

  socket.on('time:ping', (payload, ack = () => {}) => {
    if (session) {
      const room = rooms.get(session.roomId);
      if (room) touchRoom(room);
    }
    ack({ clientTime: Number(payload?.clientTime || 0), serverTime: Date.now() });
  });

  socket.on('disconnect', () => {
    if (session) leaveClient(session.roomId, session.actor.clientId);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.members.size === 0 && room.expiresAt <= now) rooms.delete(roomId);
  }
}, 10 * 60 * 1000).unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`DreamStream running at http://localhost:${port}`);
});
