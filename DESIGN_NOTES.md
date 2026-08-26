# Design and architecture notes

DreamStream 99 deliberately separates a static browser application from two volatile VPS services. The room protocol remains stable even when YouTube playback URLs expire, and the browser never receives an upstream Google CDN URL.

## Physical topology

```text
GitHub Pages
└── HTML / CSS / browser JavaScript
    └── HTTPS + WebSocket requests
        └── Caddy on one Linux VPS
            ├── /api/*, /healthz  → Node control :8080
            └── /media/*          → FastAPI media :8080
                                      ├── internal PO-token provider :4416
                                      └── YouTube metadata / Google CDN Range
```

Caddy is the only public application listener. With the default Compose mapping, Node and FastAPI bind only to host loopback and the PO-token provider is reachable only on the Compose network.

## Trust boundaries

The browser is untrusted. An Origin header is useful as a browser boundary but is not treated as proof of identity.

- Caddy, Node, and FastAPI each enforce the one configured GitHub Pages origin.
- The owner token and guest room token authenticate control-plane membership.
- Node signs a media-bound, 120-second `mg1` capability only for a currently joined member.
- FastAPI verifies the grant's canonical bytes, HMAC, issuer, audience, lifetime, room/member fields, and exact `MediaRef`.
- FastAPI returns a random relay capability, not the upstream URL or extractor data.
- Relay targets are restricted to credential-free HTTPS hosts at `googlevideo.com`; redirects and caller-supplied target URLs are rejected.

The shared HMAC secret exists only in Node and FastAPI process environments. It is never present in Pages, Caddy, a room snapshot, or a relay response.

## Control protocol

### Credentials

- Room IDs are eight characters from an ambiguity-free uppercase alphabet.
- Creating a room returns an owner token. The browser stores it in the URL fragment.
- Copying an invite removes the fragment. A guest receives a separate 12-hour credential from the join endpoint.
- HTTP credentials use `Authorization: Bearer …`.
- WebSocket credentials use a second subprotocol, `token.<credential>`, alongside `dreamstream-v1`; credentials are not accepted in the query string.

### Frames

Every WebSocket frame has `version: 1`. Requests also include a bounded `requestId` and receive one correlated `response`.

```js
// Client request
{ version: 1, type, requestId, payload }

// Server response
{ version: 1, type: 'response', requestId, ok, payload }

// Broadcast
{ version: 1, type: 'playback:state', payload }
```

The principal commands are `room:join`, `playback:command`, `room:permissions:update`, `chat:send`, and `ping`. Server broadcasts include snapshots, playback, members, permissions, and chat.

### Permission model

Chat is part of basic room membership. There is no `guestChat` feature flag. The only delegated permission is:

```json
{ "guestPlaybackControl": false }
```

The owner can always control playback and update this permission. A guest can load, play, pause, seek, end, or change rate only when it is enabled.

## Playback state

Room state holds a stable media identity rather than a URL:

```json
{
  "revision": 7,
  "media": { "provider": "youtube", "id": "dQw4w9WgXcQ" },
  "paused": false,
  "anchorSeconds": 42.5,
  "anchorServerMs": 1787731200000,
  "playbackRate": 1,
  "actionId": "a UUID",
  "changedBy": "Host"
}
```

The expected position at server time `t` is:

```text
paused:  anchorSeconds
playing: anchorSeconds + max(0, t - anchorServerMs) / 1000 × playbackRate
```

Clients estimate their server-clock offset with ping round trips, ignore stale revisions, and correct only meaningful drift. An `actionId` makes retried playback commands idempotent.

No playback URL appears in this state. Resolving or refreshing media does not increment the room revision and therefore cannot create a competing synchronization timeline.

## Browser media lifecycle

`PlayerAdapterRouter` accepts only a resolved object containing both the stable `MediaRef` and a relay `playbackUrl`. It always mounts `NativeMediaAdapter`; there is no IFrame fallback.

Resolution is:

```text
room MediaRef
  → POST control media-grants with room credential
  → POST media /resolve with mg1 grant + exact MediaRef
  → choose progressive relay_url
  → set video.crossOrigin
  → set video.src
```

The client caches the current resolved capability without putting it into shared state. On `401`, `403`, `404`, `410`, or a native media error, it performs one bounded single-flight re-resolution, remounts the source, restores playback rate and expected position, and resumes only if the room state is playing. Recovery is cancelled when the room changes media.

## Media resolver

The resolver constructs the canonical YouTube URL from the validated eleven-character ID. yt-dlp is configured for:

- metadata only, no playlist, download, storage, or ffmpeg transcoding;
- a Node 22 JavaScript runtime and the matching `yt-dlp-ejs` package;
- muxed, progressive MP4 candidates suitable for a native browser player;
- optional cookie file and proxy;
- a provider-neutral PO-token plugin argument, defaulting to the internal bgutil provider.

The public response is an allowlisted projection: stable media identity, title/duration, and opaque progressive stream capabilities. Upstream URLs, headers, cookies, format IDs, and raw yt-dlp dictionaries stay process-local.

## Relay and 403 recovery

`GET /relay/{capability}` requires exactly one valid bytes Range. The upstream must answer with consistent `206`, `Content-Range`, `Content-Length`, `Content-Type: video/mp4`, and `Accept-Ranges: bytes`. Encoded content and redirects are rejected so byte offsets remain exact.

`HEAD` is implemented as an upstream `GET bytes=0-0` probe because media origins do not consistently implement HEAD. The one-byte body is not consumed, while the full representation length is derived from `Content-Range`.

When an upstream target returns 403:

1. The failed target is invalidated only if its revision is still current.
2. Concurrent requests for that media/format/revision share one refresh task.
3. A global semaphore and deadline bound yt-dlp work.
4. The resolver reselects the exact previous format and revalidates the replacement URL.
5. Compare-and-swap prevents a slow refresh from overwriting a newer resolve.
6. The original Range is retried once.
7. A failed generation enters a short cooldown and returns a generic 502.

Disconnecting one browser request cannot cancel the shared refresh used by other peers. Every upstream response is closed on success, error, or cancellation.

## Volatile state and scaling

This version intentionally has no database or shared cache.

| State | Owner | Lifetime |
| --- | --- | --- |
| Rooms, messages, playback, members | Node process | Empty room expires after 24 hours; all state is lost on restart |
| Guest credential records | Node process | 12 hours or room/process expiry |
| Media grant | Signed token | Maximum 120 seconds |
| Relay capability and target | FastAPI process | 15-minute sliding idle TTL, bounded to 2,048 sessions |
| 403 refresh flight/cache | FastAPI process | Request/revision scoped |

Run exactly one control replica and one Uvicorn worker. Horizontal scaling requires an explicit shared room store and a shared or reconstructable relay-capability design; merely adding replicas would create inconsistent state.

## Failure behavior

- Control restart: existing WebSockets close and all rooms disappear. Create a new room.
- Media restart: rooms remain, but relay capabilities disappear. The browser obtains a new grant and resolves again.
- PO-token provider unavailable: media health can remain up, but some YouTube resolves may fail; inspect provider and media logs.
- Expired Google URL: transparent server-side 403 refresh, followed by bounded browser re-resolution if necessary.
- YouTube challenge or egress block: add/update the documented PO provider, EJS components, cookie file, or proxy; do not expose raw upstream URLs as a workaround.
- Foreign or missing browser Origin: reject before room creation, resolution, or relay work.

## Visual system

The product keeps three deliberately separate visual layers:

1. Windows 98 desktop and Internet Explorer shell: taskbar, menus, title bars, toolbar, desktop icons, and window controls.
2. Late-1990s web content: dense portal layout, underlined links, small badges, visitor-counter styling, and a separate chat window.
3. Modern browser behavior: real WebSockets, native video, screenshots, resilient media capabilities, keyboard-safe forms, and persisted window layouts.

The window manager uses real DOM elements and supports dragging, eight-direction resizing, focus/z-order, minimize, maximize, restore, close/reopen, taskbar switching, and local layout persistence. Pixelated MS Sans Serif is served locally and integer HiDPI scaling preserves bitmap proportions.

Asset sources and licenses are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
