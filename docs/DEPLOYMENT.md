# VPS and GitHub Pages deployment

This guide deploys the production topology used by DreamStream 99: GitHub Pages serves the browser application and one Linux VPS runs Caddy, Node control, FastAPI media, and an internal PO-token helper.

## 1. Prepare DNS and the VPS

Create an A/AAAA record for the API hostname and point it to the VPS. The default repository configuration uses:

```text
dreamstream.lucius7.dev
```

Allow inbound TCP 80 and 443 (and UDP 443 if using HTTP/3). Do not expose 8787, 8788, 8080, or 4416 publicly.

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

Start the three application services:

```bash
docker compose up -d --build control media pot-provider
docker compose ps
```

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

## 6. Optional YouTube cookies and proxy

The default stack includes the pinned bgutil PO-token provider and its yt-dlp plugin. The media image also contains Node 22 and `yt-dlp-ejs`, which are used for YouTube's JavaScript challenges. These mechanisms improve compatibility but do not guarantee every video or egress address will work.

If cookies are required, use only a dedicated low-value account and export a
Netscape-format file into:

```text
deploy/secrets/youtube.cookies.txt
```

Install it on the VPS as numeric uid/gid `10001:10001` with mode `0400`. Enable
the read-only source and its distinct private tmpfs base together:

```dotenv
YTDLP_COOKIEFILE_SOURCE=/run/secrets/youtube.cookies.txt
YTDLP_COOKIEFILE=/tmp/dreamstream-media/youtube.cookies.txt
YTDLP_PLAYER_CLIENT=default
```

Media startup copies the source into a private `0700` directory with a stable
`0600` base. Every resolve gives yt-dlp a unique disposable writable copy and
deletes it after `YoutubeDL.close()`. Never point `YTDLP_COOKIEFILE` at
`/run/secrets`, where that close would fail with `EROFS`. Recreate media after
changing either path. Never commit, paste, print,
screenshot, or add the file to an image or log. Cookies can expose the account
and may trigger account challenges or suspension. Follow the complete [safe
export, installation, verification, rotation, and revocation
procedure](YOUTUBE_COOKIES.md). Keep `YTDLP_PLAYER_CLIENT=default`; this is
yt-dlp's official special preset for its authenticated default client set, not
an arbitrary client name. Explicit `tv` failed to resolve even a known public
video with the fresh cookie, while unknown client names can be silently ignored
and fall back to defaults, invalidating attribution. Moving a workstation
cookie to a different VPS egress may also cause YouTube to rotate it into a
logged-out session; establish a fresh isolated browser session through the same
VPS egress before exporting. Acceptance
must therefore include the smoke test's real relay `Range: bytes=0-1023`
request and a `206` response. A proxy can be configured with
`YTDLP_PROXY`; the same proxy is used for metadata and byte relay so signed URL
affinity is preserved.

Current upstream guidance:

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [yt-dlp EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)

## 7. Harden and back up

- Permit SSH only from trusted networks where possible and use key authentication.
- Expose only 80/443 through the host firewall.
- Keep Docker, Caddy, Node/Python base images, yt-dlp, and the PO provider patched.
- Monitor VPS bandwidth and connection counts. This architecture does not absorb volumetric attacks.
- Back up `.env` through a secure secret system and record the working Git commit and image IDs. Room and relay state itself is intentionally disposable.
- Do not add Caddy access logging of `Authorization`, `Sec-WebSocket-Protocol`, or relay paths.

Continue with the [operations guide](OPERATIONS.md).
