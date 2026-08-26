const DEFAULT_PERMISSIONS = Object.freeze({ guestControl: false, guestChat: true });

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
    videoId: null,
    paused: true,
    anchorSeconds: 0,
    anchorServerMs: Date.now(),
    playbackRate: 1,
    changedBy: null,
    actionId: null,
  };
}

function currentPosition(playback, now = Date.now()) {
  if (!playback?.videoId || playback.paused) return Math.max(0, playback?.anchorSeconds || 0);
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
        { id: 'demo-3', clientId: 'demo-pixelcat', nickname: 'PixelCat', body: 'This is the GitHub Pages demo; no backend is required.', serverTime: now - 30000 },
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
        if (!/^[A-Za-z0-9_-]{11}$/.test(command.videoId || '')) {
          return { ok: false, error: 'Invalid video id' };
        }
        Object.assign(next, { videoId: command.videoId, paused: true, anchorSeconds: position, playbackRate: 1 });
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
      guestControl: Boolean(nextPermissions?.guestControl),
      guestChat: Boolean(nextPermissions?.guestChat),
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

/**
 * Native WebSocket transport for the future Cloudflare Worker + Durable Object.
 * Frames use { type, requestId?, payload? }; responses use
 * { type: 'response', requestId, ok, payload? }.
 */
export class WebSocketRoomClient extends RoomClient {
  constructor({ websocketUrl }) {
    super();
    if (!websocketUrl) throw new Error('WT_RUNTIME.websocketUrl is required in websocket mode');
    this.websocketUrl = websocketUrl;
    this.socket = null;
    this.connectPromise = null;
    this.pending = new Map();
    this.manualClose = false;
    this.reconnectTimer = null;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.emit('connection', { state: 'connecting' });
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.websocketUrl);
      this.socket = socket;
      const fail = (error) => reject(error instanceof Error ? error : new Error('WebSocket connection failed'));
      socket.addEventListener('open', () => {
        this.emit('connection', { state: 'connected' });
        resolve();
      }, { once: true });
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('close', () => {
        this.socket = null;
        this.connectPromise = null;
        this.emit('connection', { state: 'disconnected' });
        for (const { reject: rejectRequest, timeout } of this.pending.values()) {
          clearTimeout(timeout);
          rejectRequest(new Error('WebSocket disconnected'));
        }
        this.pending.clear();
        if (!this.manualClose) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 1200);
        }
      });
    }).catch((error) => {
      this.connectPromise = null;
      throw error;
    });
    return this.connectPromise;
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
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
      this.socket.send(JSON.stringify({ type, requestId, payload }));
    });
  }

  join(payload) { return this.request('room:join', payload); }
  sendPlayback(payload) { return this.request('playback:command', payload); }
  sendChat(payload) { return this.request('chat:send', payload); }
  updatePermissions(payload) { return this.request('room:permissions:update', payload); }
  ping(payload = {}) { return this.request('time:ping', payload); }

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'client closed');
  }
}

export function createRoomClient(runtime = {}) {
  if ((runtime.mode || 'demo') === 'demo') return new DemoRoomClient();
  if (runtime.mode === 'websocket') return new WebSocketRoomClient(runtime);
  throw new Error(`Unsupported WT_RUNTIME mode: ${runtime.mode}`);
}
