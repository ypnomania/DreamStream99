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
