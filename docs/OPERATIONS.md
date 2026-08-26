# Operations guide

DreamStream 99 keeps room and relay state in memory. Operations should favor small, observable changes and assume that restarting a service invalidates only that service's volatile state.

## Routine status

```bash
docker compose ps
docker compose logs --since=15m control media
curl --fail https://dreamstream.lucius7.dev/healthz
curl --fail https://dreamstream.lucius7.dev/media/healthz
```

Healthy containers do not prove YouTube extraction or Range delivery. Run the public smoke test after deployment, dependency changes, egress changes, or a Caddy edit:

```bash
DREAMSTREAM_BASE_URL=https://dreamstream.lucius7.dev npm run smoke:e2e
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
docker compose up -d control media pot-provider
docker compose ps
```

For a dependency-only media rebuild, verify Node, EJS, yt-dlp, and the provider plugin versions inside the resulting image before switching traffic.

## State loss and restart order

| Action | Expected impact |
| --- | --- |
| Restart Caddy | Short reconnect; control rooms and relay sessions remain |
| Restart PO provider | In-flight/future resolves may fail briefly; existing relay sessions remain |
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
3. Confirm media sees Node 22, `yt-dlp-ejs`, the bgutil plugin, and `player_client=web`.
4. Re-run the smoke test with a known public progressive video.
5. Test whether the VPS egress is being challenged or blocked.
6. Update yt-dlp/EJS/provider together and rerun the Python suite.
7. If needed, supply a protected cookie file or an affinity-preserving proxy.

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

## Caddy changes and rollback

Back up the complete active Caddyfile. Validate before every reload. After reload, test:

- health paths without Origin;
- API/media paths with missing, foreign, and exact Origins;
- an OPTIONS preflight;
- WebSocket upgrade and full smoke;
- no direct listener on public 8787/8788/4416.

To roll back application code, restore the recorded Git commit and known-good images while preserving `.env`. A control rollback/restart loses current rooms; a media rollback/restart invalidates relay capabilities. Communicate that behavior instead of trying to preserve incompatible in-memory state.
