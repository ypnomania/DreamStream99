# Operations guide

DreamStream 99 keeps room and relay state in memory. Operations should favor small, observable changes and assume that restarting a service invalidates only that service's volatile state.

## Routine status

```bash
docker compose ps
docker compose logs --since=15m control media
curl --fail https://dreamstream99.lucius7.dev/healthz
curl --fail https://dreamstream99.lucius7.dev/media/healthz
```

Healthy containers do not prove YouTube extraction or Range delivery. Run the public smoke test after deployment, dependency changes, egress changes, or a Caddy edit:

```bash
for media_id in _5GDQOm1wvw GIrBSG7RR1E 9bQmwjT-1mw; do
  DREAMSTREAM_BASE_URL=https://dreamstream99.lucius7.dev \
  DREAMSTREAM_MEDIA_ID="$media_id" npm run smoke:e2e
done
```

The PO-token sidecar's Docker logging is disabled because the upstream process prints generated token material. Use its container health and media-service outcomes rather than enabling persistent verbose logs in production.

## Safe upgrade

1. Record `git rev-parse HEAD`, `docker compose images`, and current public health.
2. Fetch and review the intended commit.
3. Keep `.env` and `deploy/secrets/` in place; never replace the shared HMAC secret during an ordinary code upgrade.
4. Run repository tests.
5. Rebuild and recreate the affected services.
6. Wait for healthy status, then run the public smoke test and a real browser room.

```bash
npm ci
npm run verify
docker compose build --pull control media
docker compose up -d control media pot-provider media-egress
docker compose ps
```

For a dependency-only media rebuild, verify Node, EJS, yt-dlp, and the provider plugin versions inside the resulting image before switching traffic.

## State loss and restart order

| Action | Expected impact |
| --- | --- |
| Restart Caddy | Short reconnect; control rooms and relay sessions remain |
| Restart PO provider | In-flight/future resolves may fail briefly; existing relay sessions remain |
| Restart Mihomo egress | In-flight resolves/relays fail; signed URLs must be refreshed after the same VLESS exit returns |
| Restart media | All opaque relay capabilities disappear; browsers must resolve again |
| Restart control | All rooms, messages, memberships, and guest credentials disappear |
| Rotate HMAC secret | Existing grants become invalid; restart control and media with the new identical value |

Only one Node control replica and one Uvicorn worker are supported. Do not add replicas behind Caddy without redesigning state ownership.

## 403 recovery checklist

An upstream 403 is normally repaired automatically:

```text
failed Range → one shared exact-format refresh → CAS publish → one Range retry
```

If the browser still fails:

1. Check media logs for a generic resolve/refresh failure; never add logging of raw URLs, cookies, headers, or tokens.
2. Confirm `pot-provider` and `media` are healthy.
3. Confirm media sees Node 22, `yt-dlp-ejs`, the bgutil plugin,
   `YTDLP_PLAYER_CLIENT=mweb`, and
   `MEDIA_EGRESS_PROXY=http://media-egress:7890` without printing any secret
   sidecar fields.
4. Re-run the smoke test with a known public progressive video.
5. Test whether the configured VLESS public exit is being challenged or blocked.
6. Update yt-dlp/EJS/provider together and rerun the Python suite.
7. If needed, supply a protected cookie file using the [dedicated-account
   procedure](YOUTUBE_COOKIES.md), or use an affinity-preserving proxy.

For production, that route is the internal Mihomo HTTP proxy and the exact
configured Hong Kong VLESS public exit—not merely another address in Hong Kong.
Cookie creation/export, yt-dlp resolution, relay byte reads, and 403 refreshes
must remain on it. Request the public relay with `Range: bytes=0-1023` and
require `206 Partial Content`, a valid `Content-Range`, and a non-empty body.

The relay retries only once and cools down a failed generation. Repeatedly hammering the endpoint will not repair an extractor or egress problem.

## CORS and authentication incidents

- `403 ORIGIN_NOT_ALLOWED` on API/WS: compare the browser's exact scheme/host/port with `ALLOWED_ORIGIN`; repository paths are not part of an Origin.
- Preflight failure: ensure Caddy allows `Authorization, Content-Type, Range, If-Range` and `GET, HEAD, POST, OPTIONS`.
- `401` on a media resolve: check clock synchronization, the shared secret, grant lifetime, and exact media binding.
- `403 NOT_JOINED` on media grant: the credential holder must have completed `room:join` on a live WebSocket.
- Relay `404`: the opaque capability expired, was evicted, or media restarted; request a new grant and resolve.

CORS can be spoofed by a non-browser client. Treat credentials and capabilities as the authorization layer.

## Capacity and abuse

Control bounds rooms, connections, credentials, frame sizes, request bodies, chat rate, and playback command rate. Media bounds capability count and refresh concurrency, but streamed bytes are intentionally not transcoded or globally rate-limited.

Monitor:

- VPS egress bytes and provider billing;
- open connections and file descriptors;
- control room capacity/rate-limit responses;
- media resolve latency and 502 rate;
- Mihomo health/restart counts;
- disk used by Docker images and logs;
- CPU/memory during concurrent yt-dlp refreshes.

If bandwidth abuse occurs, revoke the room by restarting control (all rooms) or restart media to invalidate all relay capabilities, then investigate before reopening. A per-room revocation list or external rate limiter is not part of this version.

## Secret rotation

Rotation is a coordinated, room-disrupting operation:

1. Generate a new random value without placing it in command history or logs.
2. Update only the protected root `.env`.
3. Recreate control and media together.
4. Verify both health endpoints and run the smoke test.
5. Securely replace the backup copy.

Do not attempt a rolling rotation with different secrets; Node-issued grants would fail Python verification.

## Hong Kong VLESS media-egress lifecycle

The egress path is deliberately narrow:

```text
media --HTTP--> Mihomo --VLESS Reality/TLS/TCP--> Hong Kong exit --> Internet
```

- `media` knows only `http://media-egress:7890`. It does not mount
  `deploy/secrets/egress/media-egress.yaml`, so it cannot read the VLESS
  destination, UUID, Reality parameters, or TLS server name.
- Mihomo runs non-root on a dedicated bridge shared only with `media`, with no
  host port. Its
  minimal static configuration uses one VLESS Reality outbound and a final
  `MATCH` rule selecting it. This deployment does not consume a proxy
  subscription and has no `DIRECT` fallback.
- The ignored configuration is the only egress secret. It is mounted read-only
  into Mihomo, owned by `10001:10001` with mode `0400`, and is never copied into
  an image or environment variable.

For routine validation:

1. Confirm `media-egress` is healthy with `docker compose ps media-egress`. Its
   health check exercises Mihomo's private HTTP listener and the configured
   VLESS Reality path.
2. Confirm Compose publishes no Mihomo port, only `media` shares its dedicated
   bridge, and no unexpected host listener appeared.
3. From `media`, run the proxied Cloudflare trace and log only `loc=HK`; do not
   print the VLESS destination, UUID, Reality parameters, TLS server name, or exit
   address.
4. Run the public resolve plus `Range: bytes=0-1023` smoke. An HTTP `204` alone
   does not prove the required Hong Kong public exit or
   GoogleVideo byte delivery.

Mihomo re-establishes transport after interruption; Compose restart policies and
the end-to-end health check restore the path without exposing a host listener.
If it remains unavailable, fail closed. Never remove
`MEDIA_EGRESS_PROXY` to fall back to direct VPS egress.

Keep `media-egress.yaml` owned by `10001:10001`, mode `0400`, and outside Git.
Rotate the node by atomically installing a reviewed replacement configuration,
recreating Mihomo, validating `loc=HK`, and running every target Range smoke
before revoking the old credentials. If the
VLESS public exit changes, create a new isolated browser session through that
exact exit, rotate the cookie, and rerun every target Range smoke because
cookie affinity and existing signed GoogleVideo URLs are no longer valid.

## YouTube cookie lifecycle

Treat `deploy/secrets/media/youtube.cookies.txt` as a revocable account credential,
not ordinary configuration. It must remain owned by numeric uid/gid
`10001:10001`, mode `0400`, and mounted read-only as
`/run/secrets/youtube.cookies.txt`. Configure that path as
`YTDLP_COOKIEFILE_SOURCE`; configure `YTDLP_COOKIEFILE` as the distinct private
tmpfs base `/tmp/dreamstream-media/youtube.cookies.txt`. Never point that path at
`/run/secrets`: each resolve uses a unique disposable writable copy because
yt-dlp rewrites its jar on close, then deletes the copy without mutating the
mounted secret or the stable runtime base.

- Verify source metadata/header plus the `0700` runtime directory and `0600`
  working copy without printing cookie rows.
- Rotate with a brand-new incognito/private session through the exact configured
  Mihomo HTTP proxy and VLESS public exit used by resolution and relay. Log
  in, open a blank tab, close all YouTube tabs, export, then immediately close
  the entire private session and never reopen it. Stage the export, install it
  with the same ownership/mode, recreate only `media`, and immediately run the
  target video's real Range smoke test, requiring `206` without printing cookie
  values.
- Revoke immediately after suspected disclosure: clear both cookie path
  settings, recreate `media` to erase tmpfs, remove the server source, and
  revoke the Google session.
- A cookie committed to Git or pasted into chat, logs, screenshots, or a support
  ticket is compromised even if it is later deleted.

Use the commands and account-safety checklist in [YouTube cookie
operations](YOUTUBE_COOKIES.md). Cookie rotation recreates media and therefore
invalidates existing relay capabilities; browser recovery must resolve again.
This deployment keeps `YTDLP_PLAYER_CLIENT=mweb`: the three production
Topic/Release probes must expose progressive streams with this real client and the
Hong Kong VLESS egress. A cookie exported under a different network
egress may be rotated into a logged-out session after reaching the VPS; create
the replacement isolated browser session through the same configured Mihomo
proxy and exact VLESS public exit used by resolution, relay, and refreshes. After
rotation, run the full public smoke
test and require its real relay `Range: bytes=0-1023` request to return `206`.
A healthy process or a successful format 18 resolve alone does not validate the
cookie and player-client combination. A successful resolve is insufficient if
resolution and relay are not using the working Hong Kong VLESS route; it is accepted
only after the same exit returns a real public `206` Range response.

## Caddy changes and rollback

Back up the complete active Caddyfile. Validate before every reload. After reload, test:

- health paths without Origin;
- API/media paths with missing, foreign, and exact Origins;
- an OPTIONS preflight;
- WebSocket upgrade and full smoke;
- no direct listener on public 8787/8788/4416/7890.

To roll back application code, restore the recorded Git commit and known-good images while preserving `.env`. A control rollback/restart loses current rooms; a media rollback/restart invalidates relay capabilities. Communicate that behavior instead of trying to preserve incompatible in-memory state.
