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

  assert.match(
    documentation,
    /Malaysian (?:(?:media-)?(?:exit )?proxy|SSH exit)/i,
  );
  assert.match(documentation, /Cookie creation\/export[\s\S]*yt-dlp resolution[\s\S]*relay byte reads/);
  assert.match(
    documentation,
    /same (?:configured )?(?:Mihomo HTTP |Malaysian )?proxy and (?:exact SSH )?public exit(?: IP)?/i,
  );
  assert.match(documentation, /Range: bytes=0-1023[\s\S]*206 Partial Content/);
  assert.match(documentation, /Content-Range/);
  assert.match(documentation, /MEDIA_EGRESS_PROXY/);

  const deployEnv = await readFile(path.join(root, 'deploy', '.env.example'), 'utf8');
  const mediaEnv = await readFile(path.join(root, 'media', '.env.example'), 'utf8');
  assert.match(deployEnv, /^COMPOSE_FILE=docker-compose\.yml:deploy\/compose\.media-egress\.yml$/m);
  assert.match(deployEnv, /^MEDIA_EGRESS_PROXY=http:\/\/media-egress:7890$/m);
  assert.match(deployEnv, /^SSH_EGRESS_IPV6=2001:db8::1$/m);
  assert.match(deployEnv, /^SSH_EGRESS_PORT=22$/m);
  assert.match(deployEnv, /^SSH_EGRESS_RELAY_BIND=172\.17\.0\.1$/m);
  assert.match(deployEnv, /^SSH_EGRESS_RELAY_PORT=35201$/m);
  assert.match(deployEnv, /^YTDLP_PLAYER_CLIENT=mweb$/m);
  assert.match(mediaEnv, /^MEDIA_EGRESS_PROXY=$/m);
  for (const [filename, contents] of [
    [path.join('deploy', '.env.example'), deployEnv],
    [path.join('media', '.env.example'), mediaEnv],
  ]) {
    assert.doesNotMatch(contents, /MEDIA_EGRESS_PROXY=https?:\/\/[^\s/@]+:[^\s/@]+@/);
    assert.match(contents, /^YTDLP_PROXY=$/m, `${filename} must not contain proxy credentials`);
  }
  assert.doesNotMatch(
    deployEnv,
    /^SSH_EGRESS_(?:USERNAME|PASSWORD|PRIVATE_KEY|HOST_KEY)=/m,
  );
});

test('SSH-backed Malaysian egress is pinned, least-privilege, and mandatory for media', async () => {
  const overlay = await readFile(path.join(root, 'deploy', 'compose.media-egress.yml'), 'utf8');
  const baseCompose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const relayDockerfile = await readFile(
    path.join(root, 'deploy', 'media-egress-relay.Dockerfile'),
    'utf8',
  );
  const relay = overlay.match(
    /^  media-egress-relay:\n[\s\S]*?(?=^  media-egress:\n)/m,
  )?.[0];
  const egress = overlay.match(/^  media-egress:\n[\s\S]*?(?=^  media:\n)/m)?.[0];
  const media = overlay.match(/^  media:\n[\s\S]*$/m)?.[0];

  assert.ok(relay, 'relay service block is required');
  assert.ok(egress, 'Mihomo service block is required');
  assert.ok(media, 'media overlay block is required');

  assert.match(relayDockerfile, /^FROM alpine:3\.22\.5@sha256:[a-f0-9]{64}$/m);
  assert.match(relayDockerfile, /apk add --no-cache socat=1\.8\.1\.3-r0/);
  assert.match(relayDockerfile, /^USER 10001:10001$/m);
  assert.match(relay, /dockerfile: deploy\/media-egress-relay\.Dockerfile/);
  assert.match(relay, /network_mode: host/);
  assert.match(relay, /pids_limit: 64/);
  assert.match(relay, /user: "10001:10001"/);
  assert.match(relay, /driver: "none"/);
  assert.match(relay, /read_only: true/);
  assert.match(relay, /tmpfs:/);
  assert.match(relay, /cap_drop:\s*\n\s*- ALL/);
  assert.match(relay, /no-new-privileges:true/);
  assert.doesNotMatch(relay, /^\s{4}(?:ports|expose):/m);
  assert.match(
    relay,
    /TCP4-LISTEN:\$\{SSH_EGRESS_RELAY_PORT:-35201\},bind=\$\{SSH_EGRESS_RELAY_BIND:-172\.17\.0\.1\},reuseaddr,fork/,
  );
  assert.match(
    relay,
    /TCP6:\[\$\{SSH_EGRESS_IPV6:\?set SSH_EGRESS_IPV6 in \.env\}\]:\$\{SSH_EGRESS_PORT:-22\},connect-timeout=10/,
  );
  assert.match(relay, /\$\{SSH_EGRESS_RELAY_BIND:-172\.17\.0\.1\}/);
  assert.match(relay, /\$\{SSH_EGRESS_RELAY_PORT:-35201\}/);

  assert.match(egress, /metacubex\/mihomo:v1\.19\.29@sha256:[a-f0-9]{64}/);
  assert.match(egress, /user: "10001:10001"/);
  assert.match(egress, /driver: "none"/);
  assert.match(egress, /SAFE_PATHS: \/run\/secrets/);
  assert.match(
    egress,
    /source: \.\/deploy\/secrets\/egress\/media-egress\.yaml[\s\S]*?target: \/run\/secrets\/media-egress\.yaml[\s\S]*?read_only: true[\s\S]*?create_host_path: false/,
  );
  assert.match(
    egress,
    /source: \.\/deploy\/secrets\/egress\/media-egress-ssh-key[\s\S]*?target: \/run\/secrets\/media-egress-ssh-key[\s\S]*?read_only: true[\s\S]*?create_host_path: false/,
  );
  assert.match(egress, /cap_drop:\s*\n\s*- ALL/);
  assert.match(egress, /no-new-privileges:true/);
  assert.match(
    egress,
    /media-egress-relay:\s*\n\s*condition: service_healthy/,
  );
  assert.match(egress, /http_proxy=http:\/\/127\.0\.0\.1:7890/);
  assert.match(
    egress,
    /wget -qO \/dev\/null -T 15 http:\/\/cp\.cloudflare\.com\/generate_204/,
  );

  assert.match(media, /MEDIA_EGRESS_PROXY: \$\{MEDIA_EGRESS_PROXY:-http:\/\/media-egress:7890\}/);
  assert.match(media, /media-egress:\s*\n\s*condition: service_healthy/);
  assert.doesNotMatch(overlay, /^\s*ports:/m);
  assert.match(baseCompose, /MEDIA_EGRESS_PROXY: \$\{MEDIA_EGRESS_PROXY:-\}/);
  assert.match(baseCompose, /deploy\/secrets\/media:\/run\/secrets:ro/);
  assert.doesNotMatch(baseCompose, /deploy\/secrets:\/run\/secrets:ro/);
  assert.doesNotMatch(baseCompose, /media-egress\.yaml/);
  assert.doesNotMatch(baseCompose, /media-egress-ssh-key/);
});
