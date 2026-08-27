import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cookie deployment contract stays least-privilege and discoverable', async () => {
  const [compose, environment, guide, ignore, readme, deployment, operations] = await Promise.all([
    readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../docs/YOUTUBE_COOKIES.md', import.meta.url), 'utf8'),
    readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/DEPLOYMENT.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/OPERATIONS.md', import.meta.url), 'utf8'),
  ]);

  assert.match(compose, /\.\/deploy\/secrets\/media:\/run\/secrets:ro/);
  assert.doesNotMatch(compose, /\.\/deploy\/secrets:\/run\/secrets:ro/);
  assert.match(compose, /YTDLP_COOKIEFILE_SOURCE:\s*\$\{YTDLP_COOKIEFILE_SOURCE:-\}/);
  assert.match(compose, /YTDLP_COOKIEFILE:\s*\$\{YTDLP_COOKIEFILE:-\}/);
  assert.match(compose, /YTDLP_PLAYER_CLIENT:\s*\$\{YTDLP_PLAYER_CLIENT:-default\}/);
  assert.match(environment, /^YTDLP_COOKIEFILE_SOURCE=$/m);
  assert.match(environment, /^YTDLP_COOKIEFILE=$/m);
  assert.match(environment, /^YTDLP_PLAYER_CLIENT=mweb$/m);
  assert.match(environment, /^MEDIA_EGRESS_PROXY=http:\/\/media-egress:7890$/m);
  assert.doesNotMatch(environment, /^(?:SSH_EGRESS|VLESS_)[A-Z0-9_]*=/m);
  assert.match(environment, /\/run\/secrets\/youtube\.cookies\.txt/);
  assert.match(ignore, /^deploy\/secrets\/\*$/m);
  assert.match(ignore, /^deploy\/secrets\/egress\/\*$/m);
  assert.match(guide, /Netscape HTTP Cookie File/);
  assert.match(guide, /install -o 10001 -g 10001 -m 0400/);
  assert.match(guide, /YTDLP_COOKIEFILE_SOURCE=\/run\/secrets\/youtube\.cookies\.txt/);
  assert.match(guide, /YTDLP_COOKIEFILE=\/tmp\/dreamstream-media\/youtube\.cookies\.txt/);
  assert.match(guide, /YoutubeDL\.close\(\)/);
  assert.match(guide, /Range: bytes=0-1023/);
  assert.match(guide, /return `206`/);
  assert.match(guide, /format 18.*insufficient/s);
  assert.match(guide, /generic code default remains yt-dlp's authenticated `default`/);
  assert.match(
    guide,
    /exact configured\s+Mihomo HTTP proxy and Hong Kong VLESS public exit/s,
  );
  assert.match(guide, /brand-new\s+incognito\/private browser session/s);
  assert.match(guide, /close the\s+entire private session and never reopen it/s);
  assert.match(guide, /Rotate and revoke/);
  assert.match(guide, /Do not commit, paste, email/);
  assert.match(readme, /docs\/YOUTUBE_COOKIES\.md/);
  assert.match(deployment, /\(YOUTUBE_COOKIES\.md\)/);
  assert.match(operations, /\(YOUTUBE_COOKIES\.md\)/);
  assert.doesNotMatch(compose, /media-egress-ssh-key/);
});
