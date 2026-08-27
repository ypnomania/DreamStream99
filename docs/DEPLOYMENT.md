# VPS and GitHub Pages deployment

This guide deploys the production topology used by DreamStream 99: GitHub Pages
serves the browser application and one Linux VPS runs Caddy, Node control,
FastAPI media, a private Mihomo-to-SSH egress, a host-network socat relay, and
an internal PO-token helper.

## 1. Prepare DNS and the VPS

Create an A/AAAA record for the API hostname and point it to the VPS. The default repository configuration uses:

```text
dreamstream.lucius7.dev
```

Allow inbound TCP 80 and 443 (and UDP 443 if using HTTP/3). Do not expose 8787,
8788, 8080, 4416, or the internal relay port `35201` publicly.

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
  `deploy/secrets/egress/media-egress.yaml`. It must contain one SSH outbound
  using a dedicated non-root account, with
  `private-key: /run/secrets/media-egress-ssh-key` on one YAML line and a non-empty
  `host-key` pin list. Point
  its SSH `server` and `port` at the bridge relay values below. Do not use a
  proxy subscription, proxy provider, unrelated outbound, controller secret,
  or LAN listener.
- Add these production values:

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/compose.media-egress.yml
MEDIA_EGRESS_PROXY=http://media-egress:7890
YTDLP_PROXY=
YTDLP_PLAYER_CLIENT=mweb
SSH_EGRESS_IPV6=<ipv6-only-ssh-address>
SSH_EGRESS_PORT=22
SSH_EGRESS_RELAY_BIND=172.17.0.1
SSH_EGRESS_RELAY_PORT=35201
```

`SSH_EGRESS_IPV6` is the real IPv6-only SSH destination and must remain only in
the protected root `.env`. `SSH_EGRESS_PORT=22` is the remote SSH service.
`SSH_EGRESS_RELAY_BIND` is the Docker bridge gateway's private IPv4 address and
must match Mihomo's SSH `server`; `SSH_EGRESS_RELAY_PORT=35201` must match its
SSH `port`. Port `35201` is only the private TCP4 relay into socat—it is not the
remote SSH port. If the host's bridge gateway differs from the default, change
both the environment value and protected Mihomo configuration after verifying
the address locally. Never bind the relay to a wildcard, loopback, public, or
IPv6 address.

Both egress secrets are ignored by Git. Keep them readable only by the
unprivileged container uid/gid used by this stack, and install the Ed25519
private key under its exact expected name with mode `0400`:

```bash
sudo install -d -o 10001 -g 10001 -m 0700 deploy/secrets/egress
sudo install -o 10001 -g 10001 -m 0400 \
  /trusted/path/media-egress.yaml \
  deploy/secrets/egress/media-egress.yaml
sudo install -o 10001 -g 10001 -m 0400 \
  /trusted/path/media-egress-ssh-key \
  deploy/secrets/egress/media-egress-ssh-key
```

The private key is mounted only at
`/run/secrets/media-egress-ssh-key` in Mihomo. The media container mounts
neither egress secret and cannot read the key, SSH account, or host-key pins.
Obtain every host-key pin through an independently authenticated channel;
Mihomo's empty `host-key` list accepts any host key and is not permitted here.
Do not put the real IPv6 address, SSH account, private key, host keys, or any
password in committed files.

Protect the file:

```bash
chmod 600 .env
```

Node and FastAPI must import the exact same secret bytes. Do not put the secret in Pages variables, Caddy, URLs, screenshots, support messages, or committed files.

## 3. Start the VPS stack

### Option A: Compose owns Caddy

Use this on a fresh host where ports 80/443 are free:

```bash
docker compose --profile bundled-gateway up -d --build
docker compose ps
```

The gateway waits for healthy control and media services. Caddy obtains and renews TLS certificates through its persistent volumes.

### Option B: an existing host Caddy

Start the application services, host-network relay, and private egress proxy:

```bash
docker compose up -d --build control media pot-provider media-egress-relay media-egress
docker compose ps
```

The relay uses host networking only so it can reach the IPv6-only SSH target.
It listens with TCP4 solely on
`SSH_EGRESS_RELAY_BIND:SSH_EGRESS_RELAY_PORT`, then forwards to
`SSH_EGRESS_IPV6:SSH_EGRESS_PORT` with TCP6. There is no Compose `ports`
publication. Keep both egress containers non-root, read-only, without added
Linux capabilities or privilege escalation; the application sees only
Mihomo's private HTTP listener at `http://media-egress:7890`.

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
curl --fail https://dreamstream.lucius7.dev/healthz
curl --fail https://dreamstream.lucius7.dev/media/healthz
```

A protected request without the Pages Origin must fail:

```bash
curl -i -X POST https://dreamstream.lucius7.dev/api/rooms
```

The same route with the exact Origin should create a disposable room:

```bash
curl -i -X POST \
  -H 'Origin: https://ypnomania.github.io' \
  https://dreamstream.lucius7.dev/api/rooms
```

Run the full two-peer and Range smoke check from a trusted checkout:

```bash
npm ci
DREAMSTREAM_BASE_URL=https://dreamstream.lucius7.dev npm run smoke:e2e
```

Expected output reports `control: true`, a media title, a nonzero byte count, and a `Content-Range` beginning with `bytes 0-`. The script deliberately omits room credentials and grants from its output.

## 5. Deploy GitHub Pages

For a fork, edit [`.github/workflows/pages.yml`](../.github/workflows/pages.yml):

```yaml
WT_RUNTIME_MODE: websocket
WT_API_URL: https://your-api-host.example/api/rooms
WT_WEBSOCKET_URL: wss://your-api-host.example/api/rooms
WT_MEDIA_URL: https://your-api-host.example/media
```

Set the repository's Pages source to **GitHub Actions**, then push `main`. The workflow verifies the Node/frontend code, builds `dist/`, injects only public endpoints, and deploys the artifact.

Confirm that the live `runtime-config.js` has `mode: websocket` and the intended endpoints. It must never contain `MEDIA_GRANT_SECRET`, room credentials, cookies, or upstream URLs.

## 6. YouTube cookies and Malaysian SSH egress

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
YTDLP_PLAYER_CLIENT=mweb
```

Media startup copies the source into a private `0700` directory with a stable
`0600` base. Every resolve gives yt-dlp a unique disposable writable copy and
deletes it after `YoutubeDL.close()`. Never point `YTDLP_COOKIEFILE` at
`/run/secrets`, where that close would fail with `EROFS`. Recreate media after
changing either path. Never commit, paste, print,
screenshot, or add the file to an image or log. Cookies can expose the account
and may trigger account challenges or suspension. Follow the complete [safe
export, installation, verification, rotation, and revocation
procedure](YOUTUBE_COOKIES.md). The generic code default remains yt-dlp's
authenticated `default` preset, but this deployment uses the real, supported
`mweb` client: the affected Topic/Release videos exposed no progressive stream
under `default`, while `mweb` through the same Malaysian SSH exit returned playable
Range responses. Unknown client names can be silently ignored and invalidate
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

### Malaysian SSH media-egress invariant

Production media traffic uses the dedicated Malaysian SSH exit. The media
application continues to use the internal HTTP URI
`http://media-egress:7890`; Mihomo carries that TCP traffic through the pinned
SSH connection. Keep the actual IPv6 destination only in the protected root
`.env`, and keep the dedicated SSH account and host-key pins only in the
protected Mihomo configuration. Keep the Ed25519 private key only in
`media-egress-ssh-key`. This is one static SSH egress, not a proxy subscription.

Cookie creation/export, yt-dlp resolution, relay byte reads, and every refresh
after an upstream 403 must use the same Mihomo HTTP proxy and exact SSH public
exit. A country label alone is insufficient: do not mix one Malaysian address
for cookies with direct VPS egress or another address for resolution or relay.
If the SSH public exit changes, create a fresh isolated cookie session.

Acceptance must exercise the public Caddy path end to end: call `/media/resolve`,
then request the returned relay URL with `Range: bytes=0-1023`. Require `206
Partial Content`, a `Content-Range: bytes 0-...` header, and a non-empty body no
larger than 1024 bytes. Health, resolve, or `HEAD` success alone is insufficient.

Verify the running proxy from inside the media network without printing its SSH
destination, account, pins, key, or public exit address:

```bash
docker compose exec -T media python - <<'PY'
import os
import httpx

proxy = os.environ['MEDIA_EGRESS_PROXY']
with httpx.Client(proxy=proxy, trust_env=False, timeout=20) as client:
    trace = client.get('https://www.cloudflare.com/cdn-cgi/trace').text
country = dict(line.split('=', 1) for line in trace.splitlines() if '=' in line).get('loc')
assert country == 'MY', country
print('media_egress_country=MY')
PY
```

Then run the public smoke against the actual affected videos, one at a time:

```bash
for media_id in _5GDQOm1wvw GIrBSG7RR1E 9bQmwjT-1mw; do
  DREAMSTREAM_BASE_URL=https://dreamstream.lucius7.dev \
  DREAMSTREAM_MEDIA_ID="$media_id" \
    npm run smoke:e2e
done
```

Current upstream guidance:

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [yt-dlp EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)

## 7. Harden and back up

- Use a dedicated non-root SSH account and a dedicated Ed25519 key. Disable
  password authentication for that account, restrict it to required TCP
  forwarding, and deny shell/subsystem, PTY, agent, X11, reverse-forwarding,
  and tunnel access.
- Pin the expected SSH host key in Mihomo; never accept an empty pin set or
  disable verification.
- Confirm host-network socat listens only on the configured Docker bridge
  gateway address. A listener on `0.0.0.0`, `[::]`, loopback, or any public
  address is a deployment failure.
- Expose only 80/443 through the host firewall.
- Keep Docker, Caddy, Node/Python base images, yt-dlp, and the PO provider patched.
- Monitor VPS bandwidth and connection counts. This architecture does not absorb volumetric attacks.
- Back up `.env` through a secure secret system and record the working Git commit and image IDs. Room and relay state itself is intentionally disposable.
- Do not add Caddy access logging of `Authorization`, `Sec-WebSocket-Protocol`, or relay paths.

Continue with the [operations guide](OPERATIONS.md).
