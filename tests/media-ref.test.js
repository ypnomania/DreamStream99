import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalMediaUrl } from '../public/js/media-ref.js';

test('canonicalMediaUrl reconstructs a safe public YouTube URL from MediaRef', () => {
  assert.equal(
    canonicalMediaUrl({ provider: 'youtube', id: 'dQw4w9WgXcQ' }),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
});

test('canonicalMediaUrl rejects unsupported or malformed media references', () => {
  assert.equal(canonicalMediaUrl(null), '');
  assert.equal(canonicalMediaUrl({ provider: 'vimeo', id: 'dQw4w9WgXcQ' }), '');
  assert.equal(canonicalMediaUrl({ provider: 'youtube', id: 'too-short' }), '');
  assert.equal(canonicalMediaUrl({ provider: 'youtube', id: 'bad<script>' }), '');
});
