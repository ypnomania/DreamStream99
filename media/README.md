# DreamStream99 media service

This FastAPI service runs as one VPS container behind host Caddy. It resolves an
authorized YouTube video into opaque relay capabilities and streams progressive
MP4 byte ranges without exposing signed `googlevideo.com` URLs.

## Contract and security

`POST /resolve` accepts only:

```http
Authorization: Bearer mg1.<canonical-claims>.<hmac-sha256>
Content-Type: application/json

{"media":{"provider":"youtube","id":"dQw4w9WgXcQ"}}
```

The verifier is byte-compatible with the Node signer and shared test vector: canonical JSON,
domain-separated HMAC-SHA256, fixed issuer/audience, a maximum 120-second
lifetime, strict room/member claims, and exact media binding are enforced. The
canonical YouTube URL is constructed internally. Invalid, expired,
future-issued, tampered, or media-mismatched grants return
`401 invalid_media_grant` before yt-dlp runs.

The response contains metadata and muxed progressive MP4 capabilities. Upstream
URLs, cookies, headers, format IDs, and raw extractor fields never leave the
process. `GET /relay/{opaque}` requires one Range header. `HEAD` uses a validated
`bytes=0-0` GET probe and returns no body. The relay accepts only HTTPS
`googlevideo.com`, never follows redirects, validates 206 metadata, and exposes
only Content-Range, Content-Length, Content-Type, and Accept-Ranges.

Capabilities live in a bounded in-memory store (2,048 entries, 15-minute sliding
idle TTL). Missing/expired capabilities return `relay_session_not_found`; after
expiry or restart the browser must obtain a fresh grant and resolve again.

On upstream 403, same-revision requests share one bounded refresh. The exact
format is reselected, CAS prevents a slow refresh overwriting a newer resolve,
and the original Range is retried once. Responses are always closed. Refresh
timeout, concurrency, and failed-generation cooldown turn exhaustion into a
generic 502 without leaking origin details.

CORS allows only `https://ypnomania.github.io`; `/resolve` and every relay request
require that exact Origin, so missing, duplicate, and foreign origins are
rejected. `/healthz` remains available without Origin for Caddy/Docker health
checks. Self-hosted forks may set one canonical `ALLOWED_ORIGIN` HTTPS origin;
the same exact value must be configured in control, media, and Caddy. Lists,
wildcards, credentials, paths, queries, fragments, and noncanonical origins are
rejected at media startup. Caddy should reinforce this and route only those
three path groups.

## Configuration and VPS run

Copy `.env.example` to an untracked `.env`. `MEDIA_GRANT_SECRET` is required and
must contain the exact same random 32-4096 UTF-8 bytes as the Node control
service. Keep it out of Compose YAML, Caddy config, logs, and Git.

Optional settings include `YTDLP_COOKIEFILE`, `YTDLP_PROXY`,
`YTDLP_SOCKET_TIMEOUT`, and provider-neutral `YTDLP_PO_TOKEN_PROVIDER`, e.g.
`youtubepot-bgutilhttp:base_url=http://pot-provider:4416`. Install a selected
plugin at build time with `--build-arg YTDLP_PLUGIN_PACKAGE=<package>`.
The root Compose file enables the pinned open-source bgutil provider and plugin
by default as an internal-only Media Plane sidecar; it publishes no host port.

The image includes the matching `yt-dlp-ejs` package and an isolated Node 22
runtime for YouTube's current JavaScript challenges. Node is explicitly enabled
through yt-dlp's `js_runtimes` option; runtime EJS downloads are not enabled.
`yt-dlp` is pinned to 2026.08.19, whose default dependency group pins
`yt-dlp-ejs` 0.8.0. When the HTTP PO provider is configured, the resolver uses
the matching `web` client; alternative provider plugins must support that
client. Upgrade yt-dlp/EJS and both bgutil plugin/server pins together, then run
the real integration suite before deployment. A PO token reduces some 403
failure modes but is not a guarantee of access.

The image runs unprivileged on 8080, disables Uvicorn access logs so relay
capability paths are not persisted, and has a `/healthz` Docker health check:

```bash
docker build --tag dreamstream-media:latest media
docker run --detach --restart unless-stopped --name dreamstream-media \
  --env-file media/.env --publish 127.0.0.1:8080:8080 dreamstream-media:latest
```

Use exactly one Uvicorn worker: capability, CAS, and single-flight state are
process-local. A restart intentionally invalidates all capabilities.

Third-party licenses, including the copyleft obligations introduced by the
default yt-dlp extras and bgutil provider, are summarized in
`media/THIRD_PARTY_NOTICES.md` and retained inside the image. If `YTDLP_PROXY`
is enabled, ensure the PO provider uses compatible egress/session settings too;
tokens generated through a different network identity may still produce 403s.

## Tests

```bash
cd media
python3.13 -m venv .venv
.venv/bin/pip install --editable '.[test]'
.venv/bin/pytest
```

Tests cover the shared Node/Python grant vector, strict resolve/CORS contract,
TTL/capacity, Range/HEAD fidelity, streaming cancellation and cleanup, 403
single-flight/CAS/one-retry recovery, timeout/cooldown, and SSRF/header bounds.
Real YouTube checks are opt-in with `RUN_YOUTUBE_INTEGRATION=1`; override video
IDs through `YOUTUBE_REGULAR_TEST_ID`, `YOUTUBE_AGE_RESTRICTED_TEST_ID`, and
`YOUTUBE_DASH_TEST_ID`. They may require cookies, PO tokens, or accepted egress.
