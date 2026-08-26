import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public');
const output = path.join(root, 'dist');
const runtime = readRuntimeEnvironment(process.env);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await rm(path.join(output, 'js', 'desktop.js.bak'), { force: true });

const htmlPath = path.join(output, 'index.html');
const html = (await readFile(htmlPath, 'utf8'))
  .replaceAll('="/', '="./')
  .replaceAll("='/", "='./");
await writeFile(htmlPath, html);

for (const filename of ['config.js', 'assets-config.js']) {
  const target = path.join(output, filename);
  const contents = (await readFile(target, 'utf8'))
    .replaceAll("'/assets/", "'./assets/")
    .replaceAll('"/assets/', '"./assets/');
  await writeFile(target, contents);
}

const runtimePath = path.join(output, 'runtime-config.js');
await writeFile(runtimePath, `${await readFile(runtimePath, 'utf8')}
Object.assign(window.WT_RUNTIME, ${JSON.stringify(runtime, null, 2)});
`);

const cssDirectory = path.join(output, 'css');
for (const filename of await readdir(cssDirectory)) {
  if (!filename.endsWith('.css')) continue;
  const cssPath = path.join(cssDirectory, filename);
  const css = (await readFile(cssPath, 'utf8'))
    .replaceAll("url('/assets/", "url('../assets/")
    .replaceAll('url("/assets/', 'url("../assets/');
  await writeFile(cssPath, css);
}

await writeFile(path.join(output, '.nojekyll'), '');
await cp(htmlPath, path.join(output, '404.html'));

console.log(`Built static Pages site in ${path.relative(root, output)}/`);

function readRuntimeEnvironment(environment) {
  const apiUrl = readPublicUrl(environment.WT_API_URL, 'WT_API_URL', ['http:', 'https:']);
  const websocketUrl = readPublicUrl(
    environment.WT_WEBSOCKET_URL,
    'WT_WEBSOCKET_URL',
    ['http:', 'https:', 'ws:', 'wss:'],
  );
  const mediaUrl = readPublicUrl(environment.WT_MEDIA_URL, 'WT_MEDIA_URL', ['http:', 'https:']);
  const mode = String(environment.WT_RUNTIME_MODE || (apiUrl ? 'websocket' : 'demo')).trim().toLowerCase();
  if (mode !== 'demo' && mode !== 'websocket') {
    throw new Error('WT_RUNTIME_MODE must be demo or websocket');
  }
  if (mode === 'websocket' && !apiUrl) {
    throw new Error('WT_API_URL is required when WT_RUNTIME_MODE=websocket');
  }
  if (mode === 'websocket' && !mediaUrl) {
    throw new Error('WT_MEDIA_URL is required when WT_RUNTIME_MODE=websocket');
  }
  return { mode, apiUrl, websocketUrl, mediaUrl };
}

function readPublicUrl(rawValue, name, allowedProtocols) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  const url = new URL(value);
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${allowedProtocols.join(' or ')}`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}
