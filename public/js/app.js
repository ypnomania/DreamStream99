import {
  mediaErrorMessage,
  MediaRecoveryController,
  shouldAutomaticallyRecoverMediaError,
} from './media-recovery.js';
import { PlayerAdapterRouter } from './player-adapter-router.js';
import { createRoomClient, normalizeRoomsApiUrl } from './room-client.js';

const $ = (selector) => document.querySelector(selector);

const config = window.WT_CONFIG;
if (!config?.copy || !config?.theme) {
  throw new Error('WT_CONFIG is missing. Check /public/config.js');
}
const copy = config.copy;
const runtime = {
  mode: 'demo',
  websocketUrl: null,
  apiUrl: null,
  mediaUrl: null,
  ...(window.WT_RUNTIME || {}),
};
const isDemoMode = runtime.mode === 'demo';
const roomClient = createRoomClient(runtime);
const CAPTURE_FONT_FAMILY = config.theme?.fontFamily || '"Pixelated MS Sans Serif", "MS Sans Serif", sans-serif';

function t(key, values = {}) {
  const template = copy[key];
  if (typeof template !== 'string') throw new Error(`Missing copy key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
}

function applyConfiguredCopy() {
  document.title = config.siteName;
  document.documentElement.style.setProperty('--desktop', config.theme.desktop);
  document.documentElement.style.setProperty('--title', config.theme.titleBar);
  document.documentElement.style.setProperty('--title-active', config.theme.titleBarActive);
  if (config.theme.fontFamily) document.documentElement.style.setProperty('--ui-font', config.theme.fontFamily);
  if (config.theme.displayFontFamily) document.documentElement.style.setProperty('--display-font', config.theme.displayFontFamily);

  for (const element of document.querySelectorAll('[data-copy]')) {
    element.textContent = t(element.dataset.copy);
  }
  for (const element of document.querySelectorAll('[data-site-name]')) {
    element.textContent = config.siteName;
  }
  for (const element of document.querySelectorAll('[data-config-oldweb]')) {
    const value = config.oldWeb?.[element.dataset.configOldweb];
    if (typeof value === 'string') element.textContent = value;
  }
  for (const element of document.querySelectorAll('[data-placeholder]')) {
    element.placeholder = t(element.dataset.placeholder);
  }
  const readPath = (root, path) => String(path || '').split('.').reduce((value, key) => value?.[key], root);

  for (const element of document.querySelectorAll('[data-asset]')) {
    const value = readPath(config.assets, element.dataset.asset);
    const optional = element.dataset.assetOptional === 'true';
    if (typeof value === 'string' && value) {
      element.src = value;
      if (optional) element.hidden = false;
      if (element.dataset.assetToggleParent) element.parentElement?.classList.add(element.dataset.assetToggleParent);
    } else if (optional) {
      element.hidden = true;
      if (element.dataset.assetToggleParent) element.parentElement?.classList.remove(element.dataset.assetToggleParent);
    }
    const fallback = element.dataset.fallback;
    if (fallback) element.addEventListener('error', () => { if (!element.src.endsWith(fallback)) element.src = fallback; }, { once: true });
  }

  for (const element of document.querySelectorAll('[data-bg-asset]')) {
    const value = readPath(config.assets, element.dataset.bgAsset);
    if (typeof value === 'string' && value) {
      element.style.backgroundImage = `url(${JSON.stringify(value)})`;
      element.classList.add('has-custom-background');
    } else {
      element.style.removeProperty('background-image');
      element.classList.remove('has-custom-background');
    }
  }

  document.querySelector('#copyInviteButton')?.setAttribute('title', t('copyInvite'));
  document.querySelector('#backButton')?.setAttribute('aria-label', t('ariaBack'));
  document.querySelector('#forwardButton')?.setAttribute('aria-label', t('ariaForward'));
  document.querySelector('#fullscreenButton')?.setAttribute('aria-label', t('ariaFullscreen'));
}

applyConfiguredCopy();

const els = {
  roomLabel: $('#roomLabel'),
  joinRoomLabel: $('#joinRoomLabel'),
  syncStatus: $('#syncStatus'),
  copyInviteButton: $('#copyInviteButton'),
  joinDialog: $('#joinDialog'),
  joinForm: $('#joinForm'),
  nicknameInput: $('#nicknameInput'),
  sourceInput: $('#sourceInput'),
  loadButton: $('#loadButton'),
  emptyPlayer: $('#emptyPlayer'),
  playerSurface: $('#playerSurface'),
  playerHost: $('#playerHost'),
  mediaBadge: $('#mediaBadge'),
  playerErrorOverlay: $('#playerErrorOverlay'),
  playerErrorMessage: $('#playerErrorMessage'),
  retryPlayerButton: $('#retryPlayerButton'),
  unmuteOverlay: $('#unmuteOverlay'),
  unmuteButton: $('#unmuteButton'),
  playButton: $('#playButton'),
  backButton: $('#backButton'),
  forwardButton: $('#forwardButton'),
  currentTime: $('#currentTime'),
  durationTime: $('#durationTime'),
  seekRange: $('#seekRange'),
  rateSelect: $('#rateSelect'),
  fullscreenButton: $('#fullscreenButton'),
  playerStage: $('#playerStage'),
  members: $('#members'),
  memberCount: $('#memberCount'),
  messages: $('#messages'),
  chatForm: $('#chatForm'),
  chatInput: $('#chatInput'),
  sendButton: $('#sendButton'),
  toast: $('#toast'),
  taskbarClock: $('#taskbarClock'),
  trayLed: $('#trayLed'),
  mediaStatusField: $('#mediaStatusField'),
  watcherCountMirror: $('#watcherCountMirror'),
  chatRoomMirror: $('#chatRoomMirror'),
  mediaAddress: $('#mediaAddress'),
  chatAddress: $('#chatAddress'),
  roleBadge: $('#roleBadge'),
  roomPermissions: $('#roomPermissions'),
  guestControlInput: $('#guestControlInput'),
};

let roomContext;
try {
  roomContext = await getOrCreateRoomContext();
} catch (error) {
  els.toast.textContent = error.message || t('toastRoomCreateFailed');
  els.toast.classList.add('show');
  throw error;
}
const { roomId, accessToken } = roomContext;
els.roomLabel.textContent = roomId;
els.joinRoomLabel.textContent = roomId;
if (els.chatRoomMirror) els.chatRoomMirror.textContent = roomId;
if (els.mediaAddress) els.mediaAddress.textContent = `http://www.dreamstream99.local/watch.php?room=${roomId.toLowerCase()}`;
if (els.chatAddress) els.chatAddress.textContent = `http://www.dialuplounge.local/room/${roomId.toLowerCase()}.shtml`;
els.nicknameInput.value = localStorage.getItem('watchTogether.nickname') || '';

let activeNickname = '';
let joined = false;
let clientId = null;
let activeRole = null;
let permissions = { guestPlaybackControl: false };
let playback = null;
let appliedRevision = -1;
let serverOffsetMs = 0;
let draggingSeek = false;
let reconnecting = false;
let toastTimer = null;
let messageHistory = [];
let clockCalibrationTimer = null;
let playerApplyGeneration = 0;
let nativeRecoveryTask = null;
let mountedMediaKey = null;
const mediaMetadataCache = new Map();
const mediaRecovery = new MediaRecoveryController();

const playerAdapterCallbacks = {
  onPlay: (position) => sendPlayback('play', { position }),
  onPause: (position) => sendPlayback('pause', { position }),
  onRateChange: (rate, position) => sendPlayback('rate', { rate, position }),
  onEnded: (position) => {
    if (activeRole === 'owner') sendPlayback('end', { position });
  },
  onMutedAutoplay: () => {
    els.unmuteOverlay.classList.remove('is-hidden');
    toast(t('toastAutoplayMuted'));
  },
  onInitError: (error) => showPlayerError(mediaErrorMessage(error, t('toastSyncFailed'))),
  onError: handlePlayerAdapterError,
};
const playerAdapterRouter = new PlayerAdapterRouter(els.playerHost, playerAdapterCallbacks);

async function getOrCreateRoomContext() {
  const url = new URL(window.location.href);
  const roomId = (url.searchParams.get('room') || '').toUpperCase();
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get('token');
  if (isDemoMode) {
    return {
      roomId: /^[A-Z0-9]{4,12}$/.test(roomId) ? roomId : 'DEMO99',
      accessToken: 'demo-owner',
    };
  }
  if (/^[A-Z0-9]{4,12}$/.test(roomId)) {
    return { roomId, accessToken: token || null };
  }

  const apiUrl = normalizeRoomsApiUrl(runtime.apiUrl);
  const response = await fetch(apiUrl, { method: 'POST' });
  if (!response.ok) throw new Error(t('toastRoomCreateFailed'));
  const created = await response.json();
  if (!/^[A-Z0-9]{4,12}$/.test(created.roomId) || typeof created.hostToken !== 'string') {
    throw new Error(t('toastRoomCreateFailed'));
  }

  url.searchParams.set('room', created.roomId);
  url.hash = new URLSearchParams({ token: created.hostToken }).toString();
  history.replaceState(null, '', url);
  return { roomId: created.roomId, accessToken: created.hostToken };
}

function setConnectionState(label, state) {
  els.syncStatus.textContent = label;
  els.syncStatus.dataset.state = state;
  els.mediaStatusField.textContent = label;
  els.trayLed.classList.toggle('online', state === 'online');
}

function updatePlayVisual(paused) {
  els.playButton.dataset.icon = paused ? 'play' : 'pause';
  els.playButton.setAttribute('aria-label', paused ? t('ariaPlay') : t('ariaPause'));
}

async function joinRoom(nickname, { silent = false } = {}) {
  const clean = nickname.trim().slice(0, 24);
  if (!clean) return;
  activeNickname = clean;
  localStorage.setItem('watchTogether.nickname', clean);
  setConnectionState(t('statusJoining'), 'syncing');

  try {
    const response = await roomClient.join({ roomId, token: accessToken, nickname: clean });
    if (!response?.ok) {
      setConnectionState(t('statusJoinFailed'), 'offline');
      toast(response?.error || t('toastJoinFailed'));
      return;
    }
    clientId = response.clientId;
    activeRole = response.role;
    joined = true;
    reconnecting = false;
    setConnectionState(t(isDemoMode ? 'statusDemo' : 'statusOnline'), 'online');
    applySnapshot(response.snapshot);
    if (!silent && els.joinDialog.open) els.joinDialog.close();
    if (!isDemoMode) {
      await calibrateClockInitially();
      scheduleClockCalibration();
    }
  } catch (error) {
    setConnectionState(t('statusJoinFailed'), 'offline');
    toast(error?.message || t('toastJoinFailed'));
  }
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  serverOffsetMs = snapshot.serverTime - Date.now();
  applyPermissions(snapshot.permissions || permissions);
  renderMembers(snapshot.members || []);
  messageHistory = Array.isArray(snapshot.messages) ? [...snapshot.messages] : [];
  renderMessageHistory(messageHistory);
  applyPlaybackState({ playback: snapshot.playback, serverTime: snapshot.serverTime }, true);
}

roomClient.onConnection(({ state }) => {
  if (state === 'connected' && activeNickname && reconnecting) {
    reconnecting = true;
    joinRoom(activeNickname, { silent: true });
  } else if (state === 'connected' && !joined) {
    setConnectionState(t('statusWaiting'), 'offline');
  } else if (state === 'disconnected' && !isDemoMode) {
    if (activeNickname) reconnecting = true;
    joined = false;
    mediaRecovery.activate(null);
    setConnectionState(t('statusReconnecting'), 'syncing');
    activeRole = null;
    clearTimeout(clockCalibrationTimer);
    updateCapabilities();
  }
});

roomClient.onSnapshot(applySnapshot);
roomClient.onPresence(renderMembers);
roomClient.onPlayback((payload) => applyPlaybackState(payload, false));
roomClient.onChat((message) => appendMessage(message, true));
roomClient.onPermissions(applyPermissions);

async function applyPlaybackState(payload, force = false) {
  const incoming = payload?.playback;
  if (!incoming) return;
  if (!force && incoming.revision <= appliedRevision) return;
  const applyGeneration = ++playerApplyGeneration;

  if (Number.isFinite(payload.serverTime)) {
    const roughOffset = payload.serverTime - Date.now();
    serverOffsetMs = serverOffsetMs * 0.85 + roughOffset * 0.15;
  }

  playback = incoming;
  appliedRevision = incoming.revision;
  updateControlsEnabled(Boolean(incoming.media));

  if (!incoming.media) {
    mediaRecovery.activate(null);
    playerAdapterRouter.destroy();
    mountedMediaKey = null;
    showVideo(false);
    return;
  }

  const incomingMediaKey = mediaCacheKey(incoming.media);
  mediaRecovery.activate(incomingMediaKey);
  if (mountedMediaKey && mountedMediaKey !== incomingMediaKey) {
    playerAdapterRouter.destroy();
    mountedMediaKey = null;
  }

  showVideo(true, incoming.media);
  hidePlayerError();
  els.rateSelect.value = String(incoming.playbackRate || 1);
  updatePlayVisual(incoming.paused);

  if (isDemoMode || !runtime.mediaUrl) {
    playerAdapterRouter.destroy();
    mountedMediaKey = null;
    showVideo(false);
    updateControlsEnabled(true);
    return;
  }

  let adapter;
  try {
    const prepared = await preparePlaybackState(incoming);
    if (applyGeneration !== playerApplyGeneration) return;
    playback = prepared;
    warmMediaMetadata(prepared).catch(() => {});
    adapter = playerAdapterRouter.select(prepared);
    mountedMediaKey = incomingMediaKey;
    await adapter.apply(prepared, expectedPosition(prepared));
  } catch (error) {
    if (applyGeneration !== playerApplyGeneration) return;
    if (adapter && adapter !== playerAdapterRouter.adapter) return;
    if (
      runtime.mediaUrl
      && shouldAutomaticallyRecoverMediaError(error, {
        nativeAdapterActive: playerAdapterRouter.activeRoute === 'native',
      })
    ) {
      try {
        await startMediaRecovery(incoming);
        return;
      } catch (recoveryError) {
        if (recoveryError?.name === 'AbortError') return;
        showPlayerError(mediaErrorMessage(recoveryError, t('toastSyncFailed')));
        return;
      }
    }
    showPlayerError(mediaErrorMessage(error, t('toastSyncFailed')));
  }
}

async function preparePlaybackState(state, { force = false } = {}) {
  if (!state?.media) return state;
  if (!runtime.mediaUrl) throw new Error('The media endpoint is not configured');
  const source = await roomClient.resolveMedia(state.media, { force, mediaUrl: runtime.mediaUrl });
  if (!source?.playbackUrl) throw new Error('The media service did not return a playable stream');
  return {
    ...state,
    playbackUrl: source.playbackUrl,
    mediaMetadata: source.metadata || null,
  };
}

function mediaCacheKey(media) {
  return media ? `${media.provider}:${media.id}` : null;
}

function handlePlayerAdapterError(code) {
  if (!runtime.mediaUrl || !playback?.media || !playback.playbackUrl) {
    const message = t('toastSyncFailed');
    toast(message);
    showPlayerError(message);
    return;
  }
  if (nativeRecoveryTask) return;
  startMediaRecovery(playback).catch((error) => {
    if (error?.name === 'AbortError') return;
    const message = mediaErrorMessage(error, t('toastSyncFailed'));
    toast(message);
    showPlayerError(message);
  });
}

function startMediaRecovery(failedPlayback) {
  if (nativeRecoveryTask) return nativeRecoveryTask;
  nativeRecoveryTask = recoverMediaPlayback(failedPlayback).finally(() => {
    nativeRecoveryTask = null;
  });
  return nativeRecoveryTask;
}

async function recoverMediaPlayback(failedPlayback) {
  const failedRevision = failedPlayback.revision;
  const key = mediaCacheKey(failedPlayback.media);
  return mediaRecovery.recover(key, async () => {
    const recoveryGeneration = ++playerApplyGeneration;
    const prepared = await preparePlaybackState(failedPlayback, { force: true });
    if (
      recoveryGeneration !== playerApplyGeneration
      || playback?.revision !== failedRevision
      || mediaCacheKey(playback?.media) !== key
    ) {
      const error = new Error('Media recovery was superseded');
      error.name = 'AbortError';
      throw error;
    }

    playback = prepared;
    const adapter = playerAdapterRouter.select(prepared);
    mountedMediaKey = key;
    hidePlayerError();
    await adapter.retry(prepared, expectedPosition(prepared));
  });
}

function showVideo(hasVideo, media = playback?.media) {
  els.emptyPlayer.classList.toggle('is-hidden', hasVideo);
  els.playerSurface.classList.toggle('is-hidden', !hasVideo);
  els.mediaBadge.classList.toggle('is-hidden', !hasVideo);

  if (hasVideo) {
    els.mediaBadge.textContent = String(media?.provider || 'MEDIA').toUpperCase();
  }

  updateControlsEnabled(hasVideo);
}

function updateControlsEnabled(enabled) {
  const disabled = !joined || !enabled || !canControlPlayback();
  els.playButton.disabled = disabled;
  els.backButton.disabled = disabled;
  els.forwardButton.disabled = disabled;
  els.rateSelect.disabled = disabled;
  els.seekRange.disabled = disabled;
  els.sourceInput.disabled = !joined || !canControlPlayback();
  els.loadButton.disabled = !joined || !canControlPlayback();
}

function canControlPlayback() {
  return activeRole === 'owner' || (activeRole === 'guest' && permissions.guestPlaybackControl);
}

function canSendChat() {
  return activeRole === 'owner' || activeRole === 'guest';
}

function applyPermissions(nextPermissions) {
  permissions = {
    guestPlaybackControl: Boolean(nextPermissions?.guestPlaybackControl),
  };
  els.guestControlInput.checked = permissions.guestPlaybackControl;
  updateCapabilities();
}

function updateCapabilities() {
  const owner = joined && activeRole === 'owner';
  els.roomPermissions.hidden = !owner;
  els.roleBadge.textContent = activeRole === 'owner' ? t('roleOwner') : t('roleGuest');
  els.roleBadge.classList.toggle('is-hidden', !joined);
  updateControlsEnabled(Boolean(playback?.media));
  enableChat(joined && canSendChat());
}

function showPlayerError(message) {
  els.playerErrorMessage.textContent = message || t('toastSyncFailed');
  els.playerErrorOverlay.classList.remove('is-hidden');
}

function hidePlayerError() {
  els.playerErrorOverlay.classList.add('is-hidden');
}

function expectedPosition(state = playback) {
  if (!state?.media) return 0;
  if (state.paused) return Math.max(0, state.anchorSeconds || 0);
  const nowServer = Date.now() + serverOffsetMs;
  const elapsed = Math.max(0, nowServer - state.anchorServerMs) / 1000;
  return Math.max(0, (state.anchorSeconds || 0) + elapsed * (state.playbackRate || 1));
}

function actualOrExpectedPosition() {
  const current = playerAdapterRouter.adapter?.getCurrentTime() || 0;
  if (current > 0 || expectedPosition() < 1) return current;
  return expectedPosition();
}

async function sendPlayback(action, extra = {}) {
  if (!joined) return toast(t('toastJoinFirst'));
  if (!canControlPlayback()) return toast(t('toastNoControl'));
  if (action !== 'load' && !playback?.media) return;

  const command = {
    action,
    actionId: crypto.randomUUID(),
    ...extra,
  };
  if (action !== 'load' && !Number.isFinite(command.position)) {
    command.position = actualOrExpectedPosition();
  }

  try {
    const response = await roomClient.sendPlayback(command);
    if (!response?.ok) toast(response?.error || t('toastCommandFailed'));
  } catch (error) {
    toast(error?.message || t('toastCommandFailed'));
  }
}

function parseMediaInput(raw) {
  const value = raw.trim();
  if (!value) throw new Error(t('toastPasteLink'));

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(t('toastInvalidLink'));
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0];
    if (!isYouTubeId(videoId)) throw new Error(t('toastYoutubeMissingId'));
    return { media: { provider: 'youtube', id: videoId }, position: parseStartTime(url) };
  }

  const isYouTubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
  const isYouTubeNoCookieHost = host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  if (isYouTubeHost || isYouTubeNoCookieHost) {
    const parts = url.pathname.split('/').filter(Boolean);
    let videoId = url.searchParams.get('v');
    if (!videoId && ['shorts', 'embed', 'live'].includes(parts[0])) videoId = parts[1];
    if (!isYouTubeId(videoId)) throw new Error(t('toastYoutubeMissingId'));
    return { media: { provider: 'youtube', id: videoId }, position: parseStartTime(url) };
  }

  throw new Error(t('toastUnsupportedLink'));
}

function isYouTubeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

function mediaIdForProvider(state, provider) {
  return state?.media?.provider === provider ? state.media.id : null;
}

function parseStartTime(url) {
  const raw = url.searchParams.get('t') || url.searchParams.get('start') || '0';
  return parseTimeValue(raw);
}

function parseTimeValue(raw) {
  if (typeof raw === 'number') return Math.max(0, raw);
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  if (/^\d{1,3}:\d{1,2}(?::\d{1,2})?$/.test(text)) {
    const parts = text.split(':').map(Number);
    return parts.reduce((sum, part) => sum * 60 + part, 0);
  }
  const h = Number(text.match(/(\d+)h/)?.[1] || 0);
  const m = Number(text.match(/(\d+)m/)?.[1] || 0);
  const s = Number(text.match(/(\d+)s/)?.[1] || 0);
  const total = h * 3600 + m * 60 + s;
  if (total > 0) return total;
  throw new Error(t('toastInvalidTime'));
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function renderMembers(members) {
  els.members.replaceChildren();
  els.memberCount.textContent = String(members.length);
  if (els.watcherCountMirror) els.watcherCountMirror.textContent = String(members.length);
  for (const member of members) {
    const chip = document.createElement('div');
    chip.className = 'member-chip';
    const avatar = document.createElement('span');
    avatar.className = 'member-avatar';
    avatar.textContent = (member.nickname || '?').slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    const role = member.role === 'owner' ? ` ${t('ownerSuffix')}` : '';
    name.textContent = member.nickname + role + (member.clientId === clientId ? t('youSuffix') : '');
    chip.append(avatar, name);
    els.members.append(chip);
  }
}

function renderMessageHistory(messages) {
  messageHistory = [];
  els.messages.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'system-message';
    empty.textContent = t('chatEmpty');
    els.messages.append(empty);
    return;
  }
  for (const message of messages) appendMessage(message, false);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendMessage(message, shouldScroll) {
  if (message) {
    messageHistory.push(message);
    if (messageHistory.length > 200) messageHistory = messageHistory.slice(-200);
  }
  els.messages.querySelector('.system-message')?.remove();
  const item = document.createElement('div');
  item.className = 'message';
  const meta = document.createElement('span');
  meta.className = 'message-meta';
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = new Date(message.serverTime || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = document.createElement('span');
  name.className = 'message-name';
  name.textContent = `<${message.nickname || 'Guest'}>`;
  const body = document.createElement('span');
  body.className = 'message-body';
  body.textContent = message.body || '';
  meta.append(time, name);
  item.append(meta, body);
  els.messages.append(item);
  if (shouldScroll) els.messages.scrollTop = els.messages.scrollHeight;
}


async function warmMediaMetadata(state = playback) {
  const videoId = mediaIdForProvider(state, 'youtube');
  if (!videoId) return null;
  const cacheKey = `youtube:${videoId}`;
  const resolvedTitle = state.mediaMetadata?.title;
  if (typeof resolvedTitle === 'string' && resolvedTitle) {
    const resolvedMeta = { media: { ...state.media }, title: resolvedTitle };
    mediaMetadataCache.set(cacheKey, resolvedMeta);
    return resolvedMeta;
  }
  if (mediaMetadataCache.has(cacheKey)) return mediaMetadataCache.get(cacheKey);

  const title = playerAdapterRouter.adapter?.getVideoTitle?.() || videoId;

  const meta = { media: { ...state.media }, title };
  mediaMetadataCache.set(cacheKey, meta);
  return meta;
}

function sanitizeFilenamePart(value, fallback = 'untitled') {
  const cleaned = String(value || '')
    .replace(/[\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  return (cleaned || fallback).slice(0, 80);
}

function formatTimestampForFilename(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}`;
}

function hashColor(text) {
  let hash = 0;
  for (const ch of String(text || '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const palette = ['#008000', '#0000CC', '#990099', '#CC0000', '#008080', '#A05A00'];
  return palette[Math.abs(hash) % palette.length];
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function drawWindowShell(ctx, x, y, width, height, title) {
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, width - 1, 1);
  ctx.fillRect(x, y, 1, height - 1);
  ctx.fillStyle = '#404040';
  ctx.fillRect(x + width - 1, y, 1, height);
  ctx.fillRect(x, y + height - 1, width, 1);
  ctx.fillStyle = '#808080';
  ctx.fillRect(x + width - 2, y + 1, 1, height - 1);
  ctx.fillRect(x + 1, y + height - 2, width - 1, 1);

  ctx.fillStyle = '#000080';
  ctx.fillRect(x + 3, y + 3, width - 6, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 11px ${CAPTURE_FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, x + 10, y + 12);

  const bx = x + width - 17;
  for (let i = 0; i < 3; i += 1) {
    const ox = bx - i * 16;
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(ox, y + 5, 14, 12);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, y + 5, 13, 1);
    ctx.fillRect(ox, y + 5, 1, 11);
    ctx.fillStyle = '#404040';
    ctx.fillRect(ox + 13, y + 5, 1, 12);
    ctx.fillRect(ox, y + 16, 14, 1);
  }

  return { x: x + 6, y: y + 24, width: width - 12, height: height - 30 };
}

function fitRect(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height };
}

async function captureVideoSurfaceCanvas() {
  const target = els.playerSurface;
  if (!mediaIdForProvider(playback, 'youtube')) throw new Error(t('toastCaptureNeedVideo'));
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t('toastCaptureFailed'));

  toast(t('toastCapturePickTab'));
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', preferCurrentTab: true, selfBrowserSurface: 'include' },
    audio: false,
  });

  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const rect = target.getBoundingClientRect();
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const sx = Math.max(0, Math.floor(rect.left * scaleX));
    const sy = Math.max(0, Math.floor(rect.top * scaleY));
    const sw = Math.max(1, Math.min(video.videoWidth - sx, Math.round(rect.width * scaleX)));
    const sh = Math.max(1, Math.min(video.videoHeight - sy, Math.round(rect.height * scaleY)));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    video.pause();
    video.srcObject = null;
    return canvas;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function buildChatCaptureCanvas(messages, roomCode) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const inner = drawWindowShell(ctx, 0, 0, 256, 1024, `${config.oldWeb?.chatBrand || 'Dial-Up Lounge'} - Chat Log`);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(inner.x, inner.y, inner.width, inner.height);

  ctx.fillStyle = '#efefef';
  ctx.fillRect(inner.x, inner.y, inner.width, 38);
  ctx.fillStyle = '#0022aa';
  ctx.font = `bold 12px ${CAPTURE_FONT_FAMILY}`;
  ctx.fillText(config.oldWeb?.chatBrand || 'Dial-Up Lounge', inner.x + 8, inner.y + 14);
  ctx.fillStyle = '#990000';
  ctx.font = `11px ${CAPTURE_FONT_FAMILY}`;
  ctx.fillText(config.oldWeb?.chatTagline || 'THE CHAT SPOT!', inner.x + 8, inner.y + 28);

  ctx.fillStyle = '#000000';
  ctx.font = `11px ${CAPTURE_FONT_FAMILY}`;
  ctx.fillText(`Room: ${roomCode}`, inner.x + 8, inner.y + 52);
  ctx.fillText('Recent chat (15)', inner.x + 8, inner.y + 66);

  const messageTop = inner.y + 76;
  const messageBottom = inner.y + inner.height - 28;
  let y = messageTop;
  const usableWidth = inner.width - 12;

  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x + 4, messageTop - 4, inner.width - 8, messageBottom - messageTop + 8);
  ctx.clip();

  const recent = messages.slice(-15);
  for (const message of recent) {
    const time = new Date(message.serverTime || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const name = `<${message.nickname || 'Guest'}>`;
    ctx.font = `11px ${CAPTURE_FONT_FAMILY}`;
    ctx.fillStyle = '#666666';
    ctx.fillText(time, inner.x + 8, y);
    y += 14;
    ctx.fillStyle = hashColor(message.nickname || 'Guest');
    ctx.fillText(name, inner.x + 8, y);
    y += 14;
    ctx.fillStyle = '#000000';
    for (const line of wrapCanvasText(ctx, message.body || '', usableWidth - 8)) {
      ctx.fillText(line, inner.x + 12, y);
      y += 13;
      if (y > messageBottom) break;
    }
    y += 8;
    if (y > messageBottom) break;
  }
  ctx.restore();

  ctx.fillStyle = '#efefef';
  ctx.fillRect(inner.x + 4, canvas.height - 62, inner.width - 8, 22);
  ctx.strokeStyle = '#808080';
  ctx.strokeRect(inner.x + 4.5, canvas.height - 61.5, inner.width - 9, 21);
  ctx.fillStyle = '#777777';
  ctx.fillRect(inner.x + inner.width - 54, canvas.height - 36, 44, 20);
  ctx.fillStyle = '#000000';
  ctx.font = `11px ${CAPTURE_FONT_FAMILY}`;
  ctx.fillText('Send', inner.x + inner.width - 44, canvas.height - 22);
  return canvas;
}

function buildCombinedCapture(frameCanvas, chatCanvas, title, seconds) {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#008080';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const left = drawWindowShell(ctx, 0, 0, 1024, 1024, `${config.oldWeb?.mediaBrand || 'DreamStream 99'} - ${title}`);
  ctx.fillStyle = '#000000';
  ctx.fillRect(left.x, left.y, left.width, left.height);
  const fitted = fitRect(frameCanvas.width, frameCanvas.height, left.width, left.height - 28);
  ctx.drawImage(frameCanvas, left.x + fitted.x, left.y + fitted.y, fitted.width, fitted.height);
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(left.x, 1024 - 26, left.width, 18);
  ctx.fillStyle = '#000000';
  ctx.font = `11px ${CAPTURE_FONT_FAMILY}`;
  ctx.fillText(`stream98 capture  |  ${title}`, left.x + 6, 1024 - 14);
  ctx.fillText(`timestamp ${formatTime(seconds)}  |  ${playback?.media?.id || ''}`, left.x + 500, 1024 - 14);

  ctx.drawImage(chatCanvas, 1024, 0);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('blob-failed')), 'image/png');
  });
}

async function downloadStream98Capture() {
  const videoId = mediaIdForProvider(playback, 'youtube');
  if (!videoId) throw new Error(t('toastCaptureNeedVideo'));
  toast(t('toastCapturePreparing'));
  const frameCanvas = await captureVideoSurfaceCanvas();
  const meta = await warmMediaMetadata(playback) || { title: videoId, media: { ...playback.media } };
  const seconds = actualOrExpectedPosition();
  const chatCanvas = buildChatCaptureCanvas(messageHistory, roomId);
  const combined = buildCombinedCapture(frameCanvas, chatCanvas, meta.title || videoId, seconds);
  const filename = `stream98_${sanitizeFilenamePart(meta.title || videoId)}_${formatTimestampForFilename(seconds)}_${sanitizeFilenamePart(videoId, 'video')}.png`;
  const blob = await canvasToBlob(combined);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(t('toastCaptureReady'));
}

function enableChat(enabled) {
  els.chatInput.disabled = !enabled;
  els.sendButton.disabled = !enabled;
}

function sampleClockOffset() {
  if (!joined) return Promise.resolve(null);
  const t0 = Date.now();
  return roomClient.ping({ clientTime: t0 }).then((payload) => {
    const t1 = Date.now();
    if (!Number.isFinite(payload?.serverTime)) return null;
    return {
      offset: payload.serverTime - (t0 + t1) / 2,
      rtt: t1 - t0,
    };
  }).catch(() => null);
}

async function calibrateClockInitially() {
  const samples = [];
  for (let index = 0; index < 5 && joined; index += 1) {
    const sample = await sampleClockOffset();
    if (sample) samples.push(sample);
  }
  samples.sort((a, b) => a.rtt - b.rtt);
  if (samples[0]) serverOffsetMs = samples[0].offset;
}

function scheduleClockCalibration() {
  clearTimeout(clockCalibrationTimer);
  if (!joined) return;
  const delayMs = 15000 + Math.random() * 15000;
  clockCalibrationTimer = setTimeout(async () => {
    const sample = await sampleClockOffset();
    if (sample) serverOffsetMs = serverOffsetMs * 0.8 + sample.offset * 0.2;
    scheduleClockCalibration();
  }, delayMs);
}

function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

els.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoom(els.nicknameInput.value);
});

els.copyInviteButton.addEventListener('click', async () => {
  if (isDemoMode) {
    toast(t('toastDemoMode'));
    return;
  }
  try {
    const invite = new URL(window.location.href);
    invite.hash = '';
    await navigator.clipboard.writeText(invite.href);
    toast(t('toastInviteCopied'));
  } catch {
    toast(t('toastCopyFailed'));
  }
});

els.loadButton.addEventListener('click', () => {
  try {
    const media = parseMediaInput(els.sourceInput.value);
    sendPlayback('load', media);
  } catch (error) {
    toast(error.message);
  }
});

els.retryPlayerButton.addEventListener('click', async () => {
  if (!playback?.media) return;
  const retryGeneration = ++playerApplyGeneration;
  hidePlayerError();
  let adapter;
  try {
    const prepared = await preparePlaybackState(playback, { force: true });
    if (retryGeneration !== playerApplyGeneration) return;
    playback = prepared;
    adapter = playerAdapterRouter.select(prepared);
    mountedMediaKey = mediaCacheKey(prepared.media);
    await adapter.retry(prepared, expectedPosition(prepared));
  } catch (error) {
    if (retryGeneration !== playerApplyGeneration) return;
    if (adapter && adapter !== playerAdapterRouter.adapter) return;
    showPlayerError(mediaErrorMessage(error, t('toastSyncFailed')));
  }
});

els.unmuteButton.addEventListener('click', () => {
  playerAdapterRouter.adapter?.unmute();
  els.unmuteOverlay.classList.add('is-hidden');
});

async function updateRoomPermissions() {
  if (activeRole !== 'owner') return;
  try {
    const response = await roomClient.updatePermissions({
      guestPlaybackControl: els.guestControlInput.checked,
    });
    if (!response?.ok) toast(response?.error || t('toastPermissionsFailed'));
  } catch (error) {
    toast(error?.message || t('toastPermissionsFailed'));
  }
}

els.guestControlInput.addEventListener('change', updateRoomPermissions);

els.sourceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') els.loadButton.click();
});

els.playButton.addEventListener('click', () => {
  const position = actualOrExpectedPosition();
  sendPlayback(playback?.paused ? 'play' : 'pause', { position });
});

els.backButton.addEventListener('click', () => {
  sendPlayback('seek', { position: Math.max(0, actualOrExpectedPosition() - 10) });
});

els.forwardButton.addEventListener('click', () => {
  sendPlayback('seek', { position: actualOrExpectedPosition() + 10 });
});

els.seekRange.addEventListener('pointerdown', () => { draggingSeek = true; });
els.seekRange.addEventListener('input', () => {
  if (draggingSeek) els.currentTime.textContent = formatTime(Number(els.seekRange.value));
});
els.seekRange.addEventListener('change', () => {
  const position = Number(els.seekRange.value);
  draggingSeek = false;
  sendPlayback('seek', { position });
});
els.seekRange.addEventListener('pointercancel', () => { draggingSeek = false; });

els.rateSelect.addEventListener('change', () => {
  sendPlayback('rate', { rate: Number(els.rateSelect.value), position: actualOrExpectedPosition() });
});

els.fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.playerStage.requestFullscreen();
  } catch {
    toast(t('toastFullscreenFailed'));
  }
});

els.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = els.chatInput.value.trim();
  if (!body || !joined || !canSendChat()) return;
  try {
    const response = await roomClient.sendChat({ body });
    if (!response?.ok) toast(response?.error || t('toastSendFailed'));
    else els.chatInput.value = '';
  } catch (error) {
    toast(error?.message || t('toastSendFailed'));
  }
});

els.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});

window.addEventListener('wt:desktop-action', async (event) => {
  if (event.detail?.action !== 'capture-stream98') return;
  try {
    await downloadStream98Capture();
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') toast(t('toastCaptureCanceled'));
    else toast(error?.message || t('toastCaptureFailed'));
  }
});

function updateTaskbarClock() {
  els.taskbarClock.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

updateTaskbarClock();
setInterval(updateTaskbarClock, 1000);

setInterval(() => {
  const adapter = playerAdapterRouter.adapter;
  if (!playback?.media || !adapter) return;
  const target = expectedPosition();
  let shown = target;
  let duration = 0;

  const current = adapter.getCurrentTime();
  if (current > 0 || target < 1) shown = current;
  duration = adapter.getDuration();
  if (!draggingSeek && duration > 0) {
    els.seekRange.max = String(duration);
    els.seekRange.value = String(Math.min(duration, shown));
    els.durationTime.textContent = formatTime(duration);
  }

  if (!draggingSeek) els.currentTime.textContent = formatTime(shown);
  updatePlayVisual(playback.paused);
}, 250);

setInterval(() => {
  const adapter = playerAdapterRouter.adapter;
  if (!playback?.media || !adapter) return;
  adapter.correctDrift(expectedPosition(), playback.paused);
}, 2000);


$('#joinDialogClose')?.addEventListener('click', () => {
  if (els.joinDialog.open) els.joinDialog.close();
});

if (isDemoMode) {
  els.copyInviteButton.textContent = t('demoModeButton');
  els.copyInviteButton.title = t('toastDemoMode');
  setConnectionState(t('statusDemo'), 'online');
}
if (typeof els.joinDialog.showModal === 'function') {
  els.joinDialog.showModal();
} else {
  els.joinDialog.setAttribute('open', '');
}

window.addEventListener('pagehide', () => {
  mediaRecovery.destroy();
  playerAdapterRouter.destroy();
  roomClient.close();
}, { once: true });
