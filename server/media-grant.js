import crypto from 'node:crypto';

export const MEDIA_GRANT_TTL_SECONDS = 120;
export const MEDIA_GRANT_SIGNING_DOMAIN = 'DreamStream99.MediaGrant.HMAC-SHA256.v1\0';

const ROOM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateMediaGrantSecret(secret) {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : null;
  if (!bytes || bytes.length < 32 || bytes.length > 4096) {
    throw new Error('MEDIA_GRANT_SECRET must contain 32-4096 UTF-8 bytes');
  }
  return bytes;
}

export function signMediaGrant({ secret, roomId, subject, role, media, nowMs = Date.now(), jti }) {
  const secretBytes = validateMediaGrantSecret(secret);
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error('Invalid media grant roomId');
  if (role !== 'owner' && role !== 'guest') throw new Error('Invalid media grant role');
  if (role === 'owner' ? subject !== 'host' : !UUID_PATTERN.test(subject)) {
    throw new Error('Invalid media grant subject');
  }
  if (
    !media
    || media.provider !== 'youtube'
    || typeof media.id !== 'string'
    || !YOUTUBE_ID_PATTERN.test(media.id)
  ) {
    throw new Error('Invalid media grant media');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('Invalid media grant time');
  const tokenId = jti ?? crypto.randomUUID();
  if (!UUID_PATTERN.test(tokenId)) throw new Error('Invalid media grant jti');
  const iat = Math.floor(nowMs / 1000);
  const claims = {
    v: 1,
    type: 'media-grant',
    iss: 'dreamstream99-control',
    aud: 'dreamstream99-media',
    roomId,
    subject,
    role,
    media: { provider: 'youtube', id: media.id },
    jti: tokenId,
    iat,
    exp: iat + MEDIA_GRANT_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const compact = `mg1.${payload}`;
  const signature = crypto
    .createHmac('sha256', secretBytes)
    .update(MEDIA_GRANT_SIGNING_DOMAIN, 'utf8')
    .update(compact, 'utf8')
    .digest('base64url');
  return { claims, expiresAt: claims.exp * 1000, token: `${compact}.${signature}` };
}
