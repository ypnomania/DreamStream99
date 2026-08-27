# YouTube cookie operations

YouTube cookies are an optional fallback when the VPS egress is challenged even
with the internal PO-token provider. A cookie file is a live account credential:
anyone who obtains it may be able to act as that account until the session is
revoked. Prefer the PO-token-only configuration and add cookies only when a real
resolve test demonstrates that they are required.

## Use a dedicated account and browser profile

- Create a low-value Google/YouTube account used only by this media service. Do
  not use a personal, administrator, paid, creator, or recovery account.
- Give it a separate browser profile with no unrelated signed-in sites, saved
  passwords, payment methods, extensions, or synchronized personal data.
- The account may be challenged, rate-limited, locked, or suspended. Cookies do
  not guarantee reliable extraction and do not change applicable content rights
  or platform terms.
- Export on a trusted workstation. Do not use an unreviewed “cookie exporter”
  extension, a shared computer, an online converter, or a remote shell recording
  service.

## Export Netscape format safely

Install a current yt-dlp release on the trusted workstation. Start a brand-new
incognito/private browser session using the dedicated account; do not reuse an
existing normal profile session. Log in, open a new blank tab, and close every
YouTube tab. Keep only the blank private tab open while exporting the browser's
cookie store. From a trusted DreamStream checkout, set a restrictive umask and
ask yt-dlp to write Netscape format directly into the ignored secret directory:

The isolated browser session should be established through the same VPS egress
that will run yt-dlp—for example, by configuring that browser profile to use a
VPS SOCKS5 endpoint or an SSH tunnel that the operator controls. In production,
the source parsed locally as `authenticated=true`, but the first VPS request
left the runtime jar unauthenticated. Re-exporting that same local session does
not fix the binding; create a new isolated session through the VPS egress and
do not change egress before validation. Immediately after export, close the
entire private session and never reopen it: later browser use can rotate the
cookies installed on the VPS.

```bash
umask 077
mkdir -p deploy/secrets
yt-dlp \
  --cookies-from-browser 'firefox:/absolute/path/to/the/dedicated/profile' \
  --cookies deploy/secrets/youtube.cookies.txt \
  --skip-download \
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
```

Use the appropriate yt-dlp browser/profile selector for the dedicated profile.
The resulting file must start with the Netscape cookie-file header. Verify only
its format and permissions—never print its cookie rows:

```bash
test "$(sed -n '1p' deploy/secrets/youtube.cookies.txt)" = '# Netscape HTTP Cookie File'
test "$(stat -f '%Lp' deploy/secrets/youtube.cookies.txt 2>/dev/null || stat -c '%a' deploy/secrets/youtube.cookies.txt)" = 600
```

Do not commit, paste, email, upload to issue trackers, include in screenshots, or
copy the file into Docker image layers. `deploy/secrets/*` is ignored by Git, but
that is only a guardrail: inspect `git status --ignored` before every commit.

## Install on the VPS

Copy through SSH to a temporary file outside the repository, then install the
final file with the media container's numeric uid/gid and read-only mode. Numeric
ownership avoids dependence on host user names.

```bash
scp deploy/secrets/youtube.cookies.txt \
  lucius7@your-vps.example:/tmp/dreamstream-youtube.cookies.incoming

ssh lucius7@your-vps.example '
  sudo install -d -o 10001 -g 10001 -m 0700 \
    /home/lucius7/dreamstream99/deploy/secrets
  sudo install -o 10001 -g 10001 -m 0400 \
    /tmp/dreamstream-youtube.cookies.incoming \
    /home/lucius7/dreamstream99/deploy/secrets/youtube.cookies.txt
  sudo rm -f /tmp/dreamstream-youtube.cookies.incoming
'
```

If the deployment account can use Docker but does not have non-interactive
`sudo`, keep the upload mode at `0600` and use the already-built media image as
a narrowly scoped root helper. This works for both first install and rotation
without making the cookie world-readable:

```bash
scp -p deploy/secrets/youtube.cookies.txt \
  lucius7@your-vps.example:/home/lucius7/.dreamstream-youtube.cookies.incoming

ssh lucius7@your-vps.example '
  chmod 0600 /home/lucius7/.dreamstream-youtube.cookies.incoming
  docker run --rm --user 0:0 --entrypoint sh \
    -v /home/lucius7/.dreamstream-youtube.cookies.incoming:/incoming:ro \
    -v /home/lucius7/dreamstream99/deploy/secrets:/secrets \
    dreamstream99-media \
    -c "install -o 10001 -g 10001 -m 0400 \
      /incoming /secrets/youtube.cookies.txt"
  rm -f /home/lucius7/.dreamstream-youtube.cookies.incoming
'
```

The staging file stays in the SSH user's home directory because the final
secret directory may already be owned by uid/gid `10001` with mode `0700`.

Set the read-only source and a distinct private tmpfs working path together in
the protected root `.env`:

```dotenv
YTDLP_COOKIEFILE_SOURCE=/run/secrets/youtube.cookies.txt
YTDLP_COOKIEFILE=/tmp/dreamstream-media/youtube.cookies.txt
YTDLP_PLAYER_CLIENT=default
```

The Compose mount exposes `deploy/secrets/` read-only at `/run/secrets`.
`YTDLP_COOKIEFILE_SOURCE` names that immutable secret; startup copies it into a
private `0700` tmpfs directory as a stable `0600` runtime base. Each resolve
creates its own disposable `0600` jar from that base, lets yt-dlp update it, and
deletes it after `YoutubeDL.close()` without writing back. Never put a host path
in either setting, never set both paths to the same file, and never point
`YTDLP_COOKIEFILE` at `/run/secrets`: using the read-only source directly causes
`EROFS`, while persisting a server-cleared request jar can poison later resolves.
Recreate only the media service:

```bash
docker compose up -d --force-recreate media
```

## Verify without exposing credentials

Check metadata, ownership, mode, and the first header line from inside the
container. This command does not print cookie values:

```bash
docker compose exec -T media python - <<'PY'
import os
import stat
from pathlib import Path

source = Path(os.environ['YTDLP_COOKIEFILE_SOURCE'])
runtime = Path(os.environ['YTDLP_COOKIEFILE'])
source_metadata = source.stat()
runtime_metadata = runtime.stat()
assert source != runtime
assert source_metadata.st_uid == source_metadata.st_gid == 10001
assert stat.S_IMODE(source_metadata.st_mode) == 0o400
assert runtime.parent.stat().st_uid == 10001
assert stat.S_IMODE(runtime.parent.stat().st_mode) == 0o700
assert runtime_metadata.st_uid == runtime_metadata.st_gid == 10001
assert stat.S_IMODE(runtime_metadata.st_mode) == 0o600
assert not list(runtime.parent.glob('.resolve.*.cookies.txt'))
with runtime.open('r', encoding='utf-8') as cookie_file:
    assert cookie_file.readline().rstrip() == '# Netscape HTTP Cookie File'
print('cookie_file_ready')
PY

docker compose ps
curl --fail https://dreamstream.lucius7.dev/media/healthz
DREAMSTREAM_BASE_URL=https://dreamstream.lucius7.dev npm run smoke:e2e
```

Health alone validates process readiness, not whether YouTube accepts the
session. Keep `YTDLP_PLAYER_CLIENT=default`: this is yt-dlp's official special
preset for authenticated defaults (`web_embedded`, `tv_downgraded`, and `web`
in the pinned release), rather than one literal client name. Explicit `tv`
failed to resolve even a known public video with the fresh cookie, while an
unknown client name may be silently ignored and fall back to defaults. A format
listing, including format 18, or a successful resolve is therefore insufficient:
run the public smoke test and require its real relay `Range: bytes=0-1023`
request to return `206`. Never add `--verbose`,
raw headers, cookies, relay capability URLs, or yt-dlp debug dumps to production
logs.

## Rotate and revoke

Rotate proactively when the dedicated session expires or is challenged, and
immediately after any suspected disclosure:

1. Export a fresh file from the dedicated profile without printing it.
2. Upload to a new temporary name and repeat `install -o 10001 -g 10001 -m 0400`.
3. Close the entire private browser session immediately after export and never
   reopen it, so subsequent browser activity cannot rotate the installed jar.
4. Recreate `media`, verify ownership/mode, and immediately run the target
   video's public smoke test, including a real relay Range request returning
   `206`; do not print cookie values during any check.
5. Delete the workstation export and upload staging file after verification.
6. Revoke the previous Google session from the account security page.

To remove cookie authorization entirely, clear both `YTDLP_COOKIEFILE_SOURCE`
and `YTDLP_COOKIEFILE` in `.env`, recreate `media` so its tmpfs copy disappears,
remove `deploy/secrets/youtube.cookies.txt`, and revoke the Google session.
Changing the dedicated account password and signing out other sessions is
appropriate after suspected compromise. A cookie committed to Git or pasted
into any third-party system must be treated as compromised even if the message
or commit is later deleted.
