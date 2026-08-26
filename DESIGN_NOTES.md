# Design and architecture notes

This document records DreamStream 99's visual boundaries, browser architecture, and Serverless direction. The current deployable version is a fully client-side GitHub Pages demo; the Cloudflare Worker and Durable Object are not yet included in this repository.

## Visual layers

The interface is deliberately divided into three layers so it feels like more than a modern website wearing a Win98 skin:

1. **Windows 98 desktop and IE shell:** title bars, taskbar, menus, address bars, toolbars, desktop icons, and window controls.
2. **1998–2000 web content:** a three-column portal, blue underlined links, 88×31 badges, a visitor counter, small footer text, and a separate chat site.
3. **Real browser features:** YouTube playback, screenshots, and `RoomClient`-driven room state and chat UI.

The overall layout and DreamStream 99 brand are original. References were used only to study period details, proportions, information density, and interaction patterns.

## Serverless boundary

### Current delivery

- GitHub Pages hosts the entire static UI.
- `DemoRoomClient` simulates members, chat, permissions, and playback state in the browser.
- The static build forces `WT_RUNTIME.mode = 'demo'` so Pages never depends accidentally on a backend.
- `WebSocketRoomClient` implements native WebSocket requests, broadcast dispatch, timeouts, and automatic reconnection.

### Planned stage

- A Cloudflare Worker will provide `POST /api/rooms`, token validation, and WebSocket upgrades.
- A Durable Object per room will store playback state, members, permissions, and recent chat, then handle broadcasts.
- WebSocket Hibernation will allow idle rooms to sleep while retaining client connections.
- The production deployment will not require Node, Socket.IO, Redis, or a traditional database.

The `server/` directory contains an earlier Express / Socket.IO synchronization prototype. It preserves the state model and provides test references, but it is not connected to the current `RoomClient` or deployed to Pages.

## RoomClient contract

The UI depends only on the shared interface exposed by [`public/js/room-client.js`](public/js/room-client.js).

| Type | Method / event | Purpose |
| --- | --- | --- |
| Command | `join()` | Join a room and receive its initial snapshot |
| Command | `sendPlayback()` | Load, play, pause, seek, or change playback speed |
| Command | `sendChat()` | Send a chat message |
| Command | `updatePermissions()` | Update guest playback and chat permissions |
| Command | `ping()` | Estimate the offset between client and server clocks |
| Event | `onSnapshot()` | Receive a complete room snapshot |
| Event | `onPresence()` | Receive the member list |
| Event | `onPlayback()` | Receive playback state |
| Event | `onChat()` | Receive one chat message |
| Event | `onPermissions()` | Receive permission changes |
| Event | `onConnection()` | Receive connection state |

WebSocket frames use this basic format:

```js
// Request
{ type, requestId, payload }

// Response
{ type: 'response', requestId, ok, payload }

// Broadcast example
{ type: 'playback:state', payload }
```

## Playback state model

Shared playback uses a server anchor instead of broadcasting the player's current time continuously:

- `revision`: monotonically increasing state version;
- `videoId`: YouTube video ID;
- `paused`: paused state;
- `anchorSeconds`: playback position at the anchor;
- `anchorServerMs`: server time corresponding to the anchor;
- `playbackRate`: playback speed;
- `actionId`: idempotency identifier for a command.

The playing position can be derived as `anchorSeconds + elapsed × playbackRate`. Clients calibrate their clocks with `ping()` and ignore stale state using `revision`.

## Window manager

Both main browser windows are real DOM elements controlled by the same lightweight window manager rather than Canvas screenshots:

- title bar dragging;
- eight-direction resizing;
- focus and `z-index`;
- minimize, maximize, and restore;
- close, reopen from a desktop icon, and taskbar switching;
- layout persistence in `localStorage`.

Window behavior draws on Win9x web GUI references, while the implementation is original to this project.

## Font and HiDPI strategy

- UI, body, and heading text use the bundled Pixelated MS Sans Serif regular and bold fonts.
- The base size is 12px, with no Canvas pre-rasterization.
- HiDPI mode scales the entire logical desktop instead of enlarging text alone.
- Automatic scaling considers the CSS viewport, `devicePixelRatio`, and estimated physical pixels.
- Integer scales of `1`, `2`, or `3` are recommended to preserve the proportions of controls, icons, and bitmap text.

## Image asset strategy

- IE toolbar artwork keeps the small native scale of the historical interface.
- Win98 system icons prefer archive references, with local fallbacks in critical locations.
- GeoCities and historical 88×31 assets with unclear rights are not bundled in bulk.
- Custom logos, GIFs, and backgrounds belong in `public/assets/custom/` and are configured through `public/assets-config.js`.
- Sources and licenses are recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Main references

- [98.css](https://github.com/jdan/98.css)
- [1j01/os-gui](https://github.com/1j01/os-gui)
- [Windows Icon Archive](https://github.com/limehawk/windows-icon-archive)
- [Windows 98 Module 2 — The Internet](https://www.tech2u.com.au/training/tech2u/win98_2/internet.html)
- [oldweb.today](https://github.com/oldweb-today/oldweb-today)
- [Windows 98 Web Edition](https://github.com/azayrahmad/win98-web)
- [Web Design Museum — 1999 gallery](https://www.webdesignmuseum.org/gallery/year-1999)
