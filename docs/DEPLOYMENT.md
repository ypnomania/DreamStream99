# VPS and GitHub Pages deployment

This guide deploys the two-node production topology used by DreamStream 99:
GitHub Pages serves the browser application, while one Linux VPS runs Caddy,
Node control, FastAPI media, a private single-node Mihomo VLESS Reality egress,
and an internal PO-token helper.

## 1. Prepare DNS and the VPS

Create an A record for the API hostname and point it to the VPS. Add an AAAA
record only after the host has a verified globally routable IPv6 address, Caddy
is listening on it, and the IPv6 firewall path passes the same public checks.
The default repository configuration uses:

```text
dreamstream99.lucius7.dev
```

Allow inbound TCP 80 and 443 (and UDP 443 if using HTTP/3). Do not expose 8787,
8788, 8080, 4416, or the Mihomo listener publicly.

Install Docker Engine and the Compose v2 plugin. Verify:

```bash
docker version
docker compose version
```

## 2. Configure the application

```bash
git clone https://github.com/ypnomania/DreamStream99.git
cd DreamStream99
cp deploy/.env.example .env
```

Edit `.env`:

- Generate a new `MEDIA_GRANT_SECRET` with at least 32 random bytes, for example `openssl rand -base64 48`.
- Set `PUBLIC_HOST` to the VPS hostname.
- Set `ALLOWED_ORIGIN` to the exact Pages origin, not the full repository URL. For `https://username.github.io/repository/`, the Origin is `https://username.github.io`.
- If the default loopback ports conflict, change only `CONTROL_PORT` and
  `MEDIA_PORT`; Compose always keeps both application listeners on `127.0.0.1`.
- Install a reviewed, minimal Mihomo configuration at
  `deploy/secrets/egress/media-egress.yaml`. It must contain one VLESS Reality
  outbound and one final `MATCH` rule selecting that outbound. Do not use a
  proxy subscription, proxy provider, unrelated outbound, external controller,
  `DIRECT` fallback, or host-published listener. The HTTP listener may bind
  inside the container because Compose attaches it to a dedicated bridge shared
  only with `media` and publishes no port.
- Add these production values:

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/compose.media-egress.yml
MEDIA_EGRESS_PROXY=http://media-egress:7890
YTDLP_PROXY=
YTDLP_PLAYER_CLIENT=web_embedded
MEDIA_RESOLVE_CACHE_TTL_SECONDS=300
MEDIA_RESOLVE_MAX_CACHE_ENTRIES=128
MEDIA_RESOLVE_MAX_CONCURRENT=1
MEDIA_RESOLVE_MAX_PENDING=8
MEDIA_RESOLVE_TIMEOUT_SECONDS=45
```

Use this shape for the ignored configuration and replace every angle-bracketed
value only on the VPS:

```yaml
port: 7890
allow-lan: true
bind-address: "*"
mode: rule
log-level: silent
proxies:
  - name: media-vless
    type: vless
    server: <vless-host>
    port: <vless-port>
    uuid: <vless-uuid>
    network: tcp
    udp: true
    flow: xtls-rprx-vision
    encryption: none
    tls: true
    skip-cert-verify: false
    servername: <tls-server-name>
    client-fingerprint: firefox
    reality-opts:
      public-key: <reality-public-key>
      short-id: <reality-short-id>
rules:
  - MATCH,media-vless
```

The egress configuration is ignored by Git. Keep it readable only by the
unprivileged container uid/gid used by this stack and install it with mode
`0400`:

```bash
sudo install -d -o 10001 -g 10001 -m 0700 deploy/secrets/egress
sudo install -o 10001 -g 10001 -m 0400 \
  /trusted/path/media-egress.yaml \
  deploy/secrets/egress/media-egress.yaml
```

Only Mihomo mounts this file. The media container cannot read the VLESS
destination, UUID, Reality key, short ID, or TLS server name. Do not put any of
those live values in `.env`, committed files, screenshots, logs, or support
messages.

Protect the file:

```bash
chmod 600 .env

# Parse the protected file with the same pinned image before starting.
docker compose run --rm --no-deps media-egress \
  -t -f /run/secrets/media-egress.yaml
```

Node and FastAPI must import the exact same secret bytes. Do not put the secret in Pages variables, Caddy, URLs, screenshots, support messages, or committed files.

### Media resolution limits

The defaults are deliberately conservative for a small VPS:

| Setting | Default | Operational effect |
| --- | --- | --- |
| `MEDIA_RESOLVE_CACHE_TTL_SECONDS` | `300` | Keeps only successful yt-dlp results for five minutes |
| `MEDIA_RESOLVE_MAX_CACHE_ENTRIES` | `128` | Applies an LRU bound to the process-local success cache |
| `MEDIA_RESOLVE_MAX_CONCURRENT` | `1` | Allows only one expensive yt-dlp extraction at a time |
| `MEDIA_RESOLVE_MAX_PENDING` | `8` | Bounds distinct running or queued extraction flights; overflow returns `503` |
| `MEDIA_RESOLVE_TIMEOUT_SECONDS` | `45` | Terminates the one-shot resolver subprocess at the overall deadline |

Concurrent requests for the same `MediaRef` always share one in-flight
extraction, so a host and newly joined guest do not duplicate work. A cold
first load normally spends several seconds resolving through YouTube and the
configured egress; a successful cache hit avoids another extraction. Keep the
global concurrency at `1` on a low-memory or single-vCPU VPS and raise it only
after measuring CPU, memory, and upstream behavior. The cache is internal:
clients still receive a fresh opaque relay capability, never a cached Google
CDN URL. Each cache miss runs in a one-shot subprocess so timeout or shutdown
can terminate yt-dlp without leaving a background thread consuming CPU.

## 3. Start the VPS stack

### Option A: Compose owns Caddy

Use this on a fresh host where ports 80/443 are free:

```bash
docker compose --profile bundled-gateway up -d --build
docker compose ps
```

The gateway waits for healthy control and media services. Caddy obtains and renews TLS certificates through its persistent volumes.

### Option B: an existing host Caddy

Start the application services and private egress proxy:

```bash
docker compose up -d --build control media pot-provider media-egress
docker compose ps
```

Mihomo dials the VLESS Reality node directly from the dedicated media-egress
Docker network; control, gateway, and the PO-token provider are not attached.
There is no Compose `ports` publication. Keep it non-root and read-only,
without added Linux capabilities or privilege escalation; the application sees
only Mihomo's private HTTP listener at `http://media-egress:7890`.

Add one import to the existing Caddyfile, using an absolute path:

```caddyfile
import /absolute/path/to/DreamStream99/deploy/Caddyfile.site
```

Edit `deploy/Caddyfile.site` first if the hostname or Pages origin differs from this repository. Validate the complete host configuration before reloading:

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If Caddy itself runs in a container, run the equivalent validate/reload commands inside that deployment. Keep a dated copy of the original Caddyfile before adding the import.

## 4. Verify the public boundary

```bash
curl --fail https://dreamstream99.lucius7.dev/healthz
curl --fail https://dreamstream99.lucius7.dev/media/healthz
```

A protected request without the Pages Origin must fail:

```bash
curl -i -X POST https://dreamstream99.lucius7.dev/api/rooms
```

The same route with the exact Origin should create a disposable room:

```bash
curl -i -X POST \
  -H 'Origin: https://ypnomania.github.io' \
  https://dreamstream99.lucius7.dev/api/rooms
```

Run the full two-peer and Range smoke check from a trusted checkout:

```bash
npm ci
DREAMSTREAM_BASE_URL=https://dreamstream99.lucius7.dev npm run smoke:e2e
```

Expected output reports `control: true`, a media title, a nonzero byte count, and a `Content-Range` beginning with `bytes 0-`. The script deliberately omits room credentials and grants from its output.

Finish with a real two-browser room: load media as the host, then join from the
invite link as a guest. Both source fields should show the same canonical
YouTube URL derived from room `MediaRef`, both clients should visibly progress
through resolving/buffering, and both native players should become ready. A
cold first load may take several seconds; it must not remain as an unexplained
black frame. Inspect neither relay capabilities nor upstream URLs during this
check, and close or pause both players afterward to stop transfer.

## 5. Deploy GitHub Pages

For a fork, edit [`.github/workflows/pages.yml`](../.github/workflows/pages.yml):

```yaml
WT_RUNTIME_MODE: websocket
WT_API_URL: https://your-api-host.example/api/rooms
WT_WEBSOCKET_URL: wss://your-api-host.example/api/rooms
WT_MEDIA_URL: https://your-api-host.example/media
```

Set the repository's Pages source to **GitHub Actions**, then push `main`. The workflow verifies the Node/frontend code, builds `dist/`, injects only public endpoints, and deploys the artifact.

Confirm that the live `runtime-config.js` has `mode: websocket` and the intended
endpoints. It must never contain `MEDIA_GRANT_SECRET`, room credentials,
cookies, or upstream URLs. The guest-visible source value is reconstructed from
the public `MediaRef`; it is not the real relay target.

## 6. YouTube cookies and Hong Kong VLESS Reality egress

The default stack includes the pinned bgutil PO-token provider and its yt-dlp plugin. The media image also contains Node 22 and `yt-dlp-ejs`, which are used for YouTube's JavaScript challenges. These mechanisms improve compatibility but do not guarantee every video or egress address will work.

If cookies are required, use only a dedicated low-value account and export a
Netscape-format file into:

```text
deploy/secrets/media/youtube.cookies.txt
```

Install it on the VPS as numeric uid/gid `10001:10001` with mode `0400`. Enable
the read-only source and its distinct private tmpfs base together:

```dotenv
YTDLP_COOKIEFILE_SOURCE=/run/secrets/youtube.cookies.txt
YTDLP_COOKIEFILE=/tmp/dreamstream-media/youtube.cookies.txt
YTDLP_PLAYER_CLIENT=web_embedded
```

Media startup copies the source into a private `0700` directory with a stable
`0600` base. Every cache-miss yt-dlp extraction gives its one-shot resolver
subprocess a unique disposable writable copy and
deletes it after `YoutubeDL.close()`. Never point `YTDLP_COOKIEFILE` at
`/run/secrets`, where that close would fail with `EROFS`. Recreate media after
changing either path. Never commit, paste, print,
screenshot, or add the file to an image or log. Cookies can expose the account
and may trigger account challenges or suspension. Follow the complete [safe
export, installation, verification, rotation, and revocation
procedure](YOUTUBE_COOKIES.md). The generic code default remains yt-dlp's
authenticated `default` preset, but this deployment uses the real, supported
`web_embedded` client: acceptance requires representative videos to expose
playable Range responses through the same Hong Kong VLESS Reality egress.
Unknown client names can be silently ignored and invalidate
test attribution. Moving a workstation
cookie to a different VPS egress may also cause YouTube to rotate it into a
logged-out session; establish a fresh isolated browser session through the same
VPS egress before exporting. Acceptance
must therefore include the smoke test's real relay `Range: bytes=0-1023`
request and a `206` response. Configure the one validated proxy with
`MEDIA_EGRESS_PROXY`; `YTDLP_PROXY` is retained only as a deprecated alias. If
both are present they must match exactly, and the service refuses to start on a
conflict. The resolver and relay explicitly ignore ambient proxy environment
variables, preventing an unnoticed split exit.

### Hong Kong VLESS media-egress invariant

Production media traffic uses one reviewed Hong Kong VLESS Reality node. The media
application continues to use the internal HTTP URI
`http://media-egress:7890`; Mihomo carries that traffic directly through the
single VLESS outbound. Keep the live node values only in the protected ignored
Mihomo configuration. This is one static egress, not a proxy subscription.

Cookie creation/export, yt-dlp resolution, relay byte reads, and every refresh
after an upstream 403 must use the same configured Mihomo HTTP proxy and exact VLESS public
exit. A country label alone is insufficient: do not mix one Hong Kong address
for cookies with direct VPS egress or another address for resolution or relay.
If the VLESS public exit changes, create a fresh isolated cookie session.

Acceptance must exercise the public Caddy path end to end: call `/media/resolve`,
then request the returned relay URL with `Range: bytes=0-1023`. Require `206
Partial Content`, a `Content-Range: bytes 0-...` header, and a non-empty body no
larger than 1024 bytes. Health, resolve, or `HEAD` success alone is insufficient.

Verify the running proxy from inside the media network without printing its
VLESS destination, credentials, Reality parameters, or public exit address:

```bash
docker compose exec -T media python - <<'PY'
import os
import httpx

proxy = os.environ['MEDIA_EGRESS_PROXY']
with httpx.Client(proxy=proxy, trust_env=False, timeout=20) as client:
    trace = client.get('https://www.cloudflare.com/cdn-cgi/trace').text
country = dict(line.split('=', 1) for line in trace.splitlines() if '=' in line).get('loc')
assert country == 'HK', country
print('media_egress_country=HK')
PY
```

Then run the public smoke against the actual affected videos, one at a time:

```bash
for media_id in _5GDQOm1wvw GIrBSG7RR1E 9bQmwjT-1mw; do
  DREAMSTREAM_BASE_URL=https://dreamstream99.lucius7.dev \
  DREAMSTREAM_MEDIA_ID="$media_id" \
    npm run smoke:e2e
done
```

Current upstream guidance:

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [yt-dlp EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)

## 7. Harden and back up

- Keep one reviewed VLESS Reality outbound with TLS verification enabled, the
  intended TLS server name, and the expected Reality public key and short ID.
  Do not configure a subscription, `DIRECT` fallback, or unrelated node.
- Treat the ignored Mihomo configuration as a live credential. Rotate the node
  credentials if it is disclosed and reinstall the file with mode `0400`.
- Confirm that Mihomo has no Compose host-port publication; only the media
  container should share its dedicated bridge and reach the HTTP listener.
- Expose only 80/443 through the host firewall.
- Keep Docker, Caddy, Node/Python base images, yt-dlp, and the PO provider patched.
- Monitor VPS bandwidth and connection counts. This architecture does not absorb volumetric attacks.
- Back up `.env` through a secure secret system and record the working Git commit and image IDs. Room and relay state itself is intentionally disposable.
- Do not add Caddy access logging of `Authorization`, `Sec-WebSocket-Protocol`, or relay paths.

Continue with the [operations guide](OPERATIONS.md).
