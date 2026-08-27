import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Compose keeps application ports on loopback and suppresses capability logs', async () => {
  const compose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const mediaDockerfile = await readFile(path.join(root, 'media', 'Dockerfile'), 'utf8');

  assert.match(compose, /127\.0\.0\.1:\$\{CONTROL_PORT:-8787\}:8080/);
  assert.match(compose, /127\.0\.0\.1:\$\{MEDIA_PORT:-8788\}:8080/);
  assert.doesNotMatch(compose, /CONTROL_BIND|MEDIA_BIND/);
  assert.match(compose, /pot-provider:[\s\S]*?logging:\s*\n\s*driver: "none"/);
  assert.match(compose, /image: caddy:2\.11\.4-alpine/);
  assert.match(mediaDockerfile, /"--no-access-log"/);
});

test('Caddy rejects missing or foreign Origins before any proxy or fallback', async () => {
  for (const filename of ['Caddyfile.site', 'Caddyfile.compose']) {
    const caddy = await readFile(path.join(root, 'deploy', filename), 'utf8');
    const route = caddy.indexOf('\troute {');
    const foreign = caddy.indexOf('respond @foreign_origin 403');
    const missing = caddy.indexOf('respond @missing_app_origin 403');
    const control = caddy.indexOf('@control path');
    const media = caddy.indexOf('handle_path /media/*');
    const fallback = caddy.lastIndexOf('\thandle {');

    assert.ok(route >= 0, `${filename} must preserve lexical route order`);
    assert.ok(foreign > route && foreign < control, `${filename} foreign Origin order`);
    assert.ok(missing > foreign && missing < control, `${filename} missing Origin order`);
    assert.ok(control < media && media < fallback, `${filename} proxy/fallback order`);
    assert.doesNotMatch(caddy, /^\s*log\s*\{/m);

    const proxyBlocks = [...caddy.matchAll(/reverse_proxy[^\{]+\{([\s\S]*?)\n\s*\}/g)];
    assert.equal(proxyBlocks.length, 2, `${filename} must define both production proxies`);
    for (const [, proxyBlock] of proxyBlocks) {
      assert.match(proxyBlock, /header_down -Access-Control-Allow-Origin/);
      assert.match(proxyBlock, /header_down -Access-Control-Expose-Headers/);
      assert.match(proxyBlock, /header_down -Vary/);
    }
  }
});

test('example secrets are intentionally invalid so forgotten setup fails fast', async () => {
  for (const filename of [
    path.join('deploy', '.env.example'),
    path.join('server', '.env.example'),
    path.join('media', '.env.example'),
  ]) {
    const contents = await readFile(path.join(root, filename), 'utf8');
    const value = contents.match(/^MEDIA_GRANT_SECRET=(.*)$/m)?.[1];
    assert.ok(value);
    assert.ok(Buffer.byteLength(value, 'utf8') < 32, `${filename} placeholder is valid by mistake`);
  }
});

test('deployment guidance preserves Malaysian proxy affinity through relay verification', async () => {
  const documentation = (
    await Promise.all([
      'README.md',
      path.join('docs', 'DEPLOYMENT.md'),
      path.join('docs', 'YOUTUBE_COOKIES.md'),
      path.join('docs', 'OPERATIONS.md'),
    ].map((filename) => readFile(path.join(root, filename), 'utf8')))
  ).join('\n');

  assert.match(documentation, /Malaysian (?:media-)?(?:exit )?proxy/i);
  assert.match(documentation, /Cookie creation\/export[\s\S]*yt-dlp resolution[\s\S]*relay byte reads/);
  assert.match(documentation, /same (?:configured )?proxy and public exit IP/i);
  assert.match(documentation, /Range: bytes=0-1023[\s\S]*206 Partial Content/);
  assert.match(documentation, /Content-Range/);
  assert.match(documentation, /MEDIA_EGRESS_PROXY/);

  const deployEnv = await readFile(path.join(root, 'deploy', '.env.example'), 'utf8');
  const mediaEnv = await readFile(path.join(root, 'media', '.env.example'), 'utf8');
  assert.match(deployEnv, /^COMPOSE_FILE=docker-compose\.yml:deploy\/compose\.media-egress\.yml$/m);
  assert.match(deployEnv, /^MEDIA_EGRESS_PROXY=http:\/\/media-egress:7890$/m);
  assert.match(deployEnv, /^YTDLP_PLAYER_CLIENT=mweb$/m);
  assert.match(mediaEnv, /^MEDIA_EGRESS_PROXY=$/m);
  for (const [filename, contents] of [
    [path.join('deploy', '.env.example'), deployEnv],
    [path.join('media', '.env.example'), mediaEnv],
  ]) {
    assert.doesNotMatch(contents, /MEDIA_EGRESS_PROXY=https?:\/\/[^\s/@]+:[^\s/@]+@/);
    assert.match(contents, /^YTDLP_PROXY=$/m, `${filename} must not contain proxy credentials`);
  }
});

test('Malaysian egress overlay is private, pinned, least-privilege, and mandatory for media', async () => {
  const overlay = await readFile(path.join(root, 'deploy', 'compose.media-egress.yml'), 'utf8');
  const baseCompose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');

  assert.match(overlay, /metacubex\/mihomo:v1\.19\.29@sha256:[a-f0-9]{64}/);
  assert.match(overlay, /user: "10001:10001"/);
  assert.match(overlay, /driver: "none"/);
  assert.match(overlay, /deploy\/secrets\/egress\/media-egress\.yaml:\/run\/secrets\/media-egress\.yaml:ro/);
  assert.match(overlay, /cap_drop:\s*\n\s*- ALL/);
  assert.match(overlay, /no-new-privileges:true/);
  assert.match(overlay, /MEDIA_EGRESS_PROXY: \$\{MEDIA_EGRESS_PROXY:-http:\/\/media-egress:7890\}/);
  assert.match(overlay, /media-egress:\s*\n\s*condition: service_healthy/);
  assert.doesNotMatch(overlay, /^\s*ports:/m);
  assert.match(baseCompose, /MEDIA_EGRESS_PROXY: \$\{MEDIA_EGRESS_PROXY:-\}/);
  assert.match(baseCompose, /deploy\/secrets\/media:\/run\/secrets:ro/);
  assert.doesNotMatch(baseCompose, /deploy\/secrets:\/run\/secrets:ro/);
  assert.doesNotMatch(baseCompose, /media-egress\.yaml/);
});
