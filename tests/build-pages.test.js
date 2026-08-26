import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Pages build emits a deployable demo by default', async () => {
  runBuild({
    WT_RUNTIME_MODE: '',
    WT_API_URL: '',
    WT_WEBSOCKET_URL: '',
    WT_MEDIA_URL: '',
  });

  const runtime = await readFile(path.join(root, 'dist/runtime-config.js'), 'utf8');
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  assert.match(runtime, /"mode": "demo"/);
  assert.match(runtime, /"mediaUrl": null/);
  assert.match(html, /src="\.\/js\/app\.js"/);
  assert.match(html, /href="\.\/css\/app\.css"/);
});

test('Pages build injects only public backend endpoints for production', async () => {
  runBuild({
    WT_RUNTIME_MODE: 'websocket',
    WT_API_URL: 'https://dreamstream.lucius7.dev/api/rooms/',
    WT_WEBSOCKET_URL: 'wss://dreamstream.lucius7.dev/api/rooms',
    WT_MEDIA_URL: 'https://dreamstream.lucius7.dev/media/',
  });

  const runtime = await readFile(path.join(root, 'dist/runtime-config.js'), 'utf8');
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  const app = await readFile(path.join(root, 'dist/js/app.js'), 'utf8');
  const router = await readFile(path.join(root, 'dist/js/player-adapter-router.js'), 'utf8');
  assert.match(runtime, /"mode": "websocket"/);
  assert.match(runtime, /"apiUrl": "https:\/\/dreamstream\.lucius7\.dev\/api\/rooms"/);
  assert.match(runtime, /"websocketUrl": "wss:\/\/dreamstream\.lucius7\.dev\/api\/rooms"/);
  assert.match(runtime, /"mediaUrl": "https:\/\/dreamstream\.lucius7\.dev\/media"/);
  assert.doesNotMatch(runtime, /TOKEN|SECRET|PASSWORD/);
  assert.doesNotMatch(`${html}\n${app}\n${router}`, /iframe_api|youtube-adapter|<iframe/i);
  assert.match(router, /new NativeMediaAdapter/);
  await assert.rejects(readFile(path.join(root, 'dist/js/youtube-adapter.js'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(root, 'dist/js/desktop.js.bak'), 'utf8'), /ENOENT/);
});

test('Pages production build rejects a missing control API endpoint', () => {
  const result = spawnSync(process.execPath, ['scripts/build-pages.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      WT_RUNTIME_MODE: 'websocket',
      WT_API_URL: '',
      WT_WEBSOCKET_URL: '',
      WT_MEDIA_URL: 'https://media.example',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WT_API_URL is required/);
});

test('Pages production build rejects a missing native media endpoint', () => {
  const result = spawnSync(process.execPath, ['scripts/build-pages.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      WT_RUNTIME_MODE: 'websocket',
      WT_API_URL: 'https://control.example/api/rooms',
      WT_WEBSOCKET_URL: 'wss://control.example/api/rooms',
      WT_MEDIA_URL: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WT_MEDIA_URL is required/);
});

function runBuild(overrides) {
  const result = spawnSync(process.execPath, ['scripts/build-pages.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
