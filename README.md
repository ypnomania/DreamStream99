# DreamStream 99

[![Deploy GitHub Pages](https://github.com/ypnomania/DreamStream99/actions/workflows/pages.yml/badge.svg)](https://github.com/ypnomania/DreamStream99/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Windows 98-style YouTube watch-party desktop with a player, chat window, member list, and screenshot tool. The current public version runs as a fully client-side GitHub Pages demo with no persistent server.

[Live demo](https://ypnomania.github.io/DreamStream99/) · [Asset replacement guide](ASSET_GUIDE.md) · [Design and architecture notes](DESIGN_NOTES.md)

![DreamStream 99 main interface](docs/images/dreamstream-overview.png)

## Current status

| Component | Status | Details |
| --- | --- | --- |
| GitHub Pages demo | Live | The UI, YouTube playback, screenshots, simulated members, and simulated chat all run in the browser |
| `RoomClient` abstraction | Complete | The UI does not depend directly on a specific room transport |
| Worker WebSocket client | Complete | `WebSocketRoomClient` defines requests, broadcasts, and reconnection behavior |
| Cloudflare Worker | Planned | Will create rooms, validate tokens, and upgrade WebSocket connections |
| Durable Object | Planned | One object per room will store playback, members, permissions, and chat state |
| Node / Socket.IO prototype | Reference only | It is not deployed to GitHub Pages or connected to the current `RoomClient` |

## Features

- Windows 98 desktop, taskbar, and Internet Explorer-style windows
- Window dragging, eight-direction resizing, minimize, maximize, close, and saved layouts
- YouTube URL parsing, play, pause, seek, playback speed, and a custom paused view
- Player and chat screenshot tool
- Simulated members, chat, and playback state available directly on GitHub Pages
- Replaceable logos, backgrounds, icons, colors, and copy
- Local Pixelated MS Sans Serif bitmap font and integer HiDPI scaling

> Demo playback, members, and chat exist only in the current page. They do not synchronize across browsers or devices.

## Serverless architecture

```text
GitHub Pages
└── Win98 UI / YouTube / Screenshot
    ├── DemoRoomClient                 Current live demo
    └── WebSocketRoomClient
        └── Cloudflare Worker          Planned
            └── Durable Object         One object per room
```

The production architecture does not require a persistent Node server, Redis, a traditional database, or a managed VPS. A Durable Object will provide strongly consistent room state and WebSocket broadcasts, while WebSocket Hibernation can reduce resource use for idle rooms.

## Run locally

Node.js 20 or newer is required.

```bash
npm ci
npm start
```

Open <http://localhost:3000>. The local page still uses `demo` mode by default. The Express / Socket.IO code in this repository is an earlier synchronization prototype, not the production Serverless backend.

Restart the server automatically during development:

```bash
npm run dev
```

Generate the same static output deployed to GitHub Pages:

```bash
npm run build
```

The build is written to `dist/`. The build script rewrites root-relative asset paths for the repository subpath and forces the output to use `demo` mode.

## Runtime modes

Runtime configuration lives in [`public/runtime-config.js`](public/runtime-config.js).

```js
window.WT_RUNTIME = {
  mode: 'demo',
  websocketUrl: null,
  apiUrl: null,
};
```

| `mode` | Client | Purpose |
| --- | --- | --- |
| `demo` | `DemoRoomClient` | GitHub Pages presentation and local UI development |
| `websocket` | `WebSocketRoomClient` | Connection to the future Cloudflare Worker |

After the Worker backend is complete, configure it as follows:

```js
window.WT_RUNTIME = {
  mode: 'websocket',
  websocketUrl: 'wss://example.workers.dev/ws',
  apiUrl: 'https://example.workers.dev/api/rooms',
};
```

The main `RoomClient` methods are `join()`, `sendPlayback()`, `sendChat()`, `updatePermissions()`, and `ping()`. Subscribe to state with `onSnapshot()`, `onPresence()`, `onPlayback()`, `onChat()`, `onPermissions()`, and `onConnection()`.

## Configuration and assets

| File | Purpose |
| --- | --- |
| [`public/config.js`](public/config.js) | Copy, theme, windows, desktop icons, and default assets |
| [`public/assets-config.js`](public/assets-config.js) | Logo, background, and icon overrides without editing the main configuration |
| [`public/runtime-config.js`](public/runtime-config.js) | Demo or WebSocket runtime selection |
| [`ASSET_GUIDE.md`](ASSET_GUIDE.md) | Custom images, scaling, and layout reset instructions |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Sources and licenses for fonts, icons, and reference artwork |

Place custom images in `public/assets/custom/`. To reset saved window and desktop icon positions, visit:

```text
http://localhost:3000/?resetLayout=1
```

All interface and body text uses the locally hosted Pixelated MS Sans Serif bitmap font. See the bundled license and third-party notices for attribution.

## Project structure

```text
public/                 Static UI and browser-side logic
  js/room-client.js     Demo and WebSocket room clients
server/                 Earlier Node / Socket.IO synchronization prototype
scripts/build-pages.js  GitHub Pages static build script
tests/                  Node.js tests
.github/workflows/      Automated verification and Pages deployment
```

## Commands

| Command | Description |
| --- | --- |
| `npm start` | Start the local Express static server and prototype API |
| `npm run dev` | Restart automatically when server files change |
| `npm run build` | Generate the `dist/` GitHub Pages site |
| `npm test` | Run all tests |
| `npm run check` | Check JavaScript syntax |
| `npm run verify` | Run syntax checks and tests |

## Automatic deployment

After a push to `main`, [`pages.yml`](.github/workflows/pages.yml) performs these steps:

1. Install locked dependencies.
2. Run `npm run verify`.
3. Run `npm run build`.
4. Upload `dist/` and deploy it to GitHub Pages.

The workflow can also be started manually with `workflow_dispatch` from GitHub Actions.

## Documentation

- [Design and architecture notes](DESIGN_NOTES.md)
- [Asset replacement guide](ASSET_GUIDE.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Font notes](public/assets/fonts/README.md)

## License

Project code is available under the [MIT License](LICENSE). Third-party fonts, icons, and image assets may use different terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
