const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function canonicalMediaUrl(media) {
  if (
    !media
    || media.provider !== 'youtube'
    || typeof media.id !== 'string'
    || !YOUTUBE_ID.test(media.id)
  ) {
    return '';
  }
  return `https://www.youtube.com/watch?v=${media.id}`;
}
