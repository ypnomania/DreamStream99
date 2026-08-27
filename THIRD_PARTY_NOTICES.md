# Third-party notices

DreamStream 99 is a personal retro web experiment. The resources below are used for interface recreation or as runtime assets.

## 98.css / Pixelated MS Sans Serif

- Project: `jdan/98.css`
- Repository: <https://github.com/jdan/98.css>
- License: MIT
- This project includes the regular and bold WOFF files in `public/assets/fonts/`, taken from commit `b1d7a907371bbe523d6f64e3af97f714fdbd6d6a` and loaded locally through `public/config.js`.

## Windows 98 system icons

- Archive/reference: <https://github.com/limehawk/windows-icon-archive>
- Upstream Win98 PNG collection referenced by the archive: `alexh/vintage-icons` and the alexmeub Win98 icon site.
- The Windows system icons remain Microsoft property. The archive site's code license does not grant a license to Microsoft's icon artwork. This personal project references external icon URLs for its intended use.

## Internet Explorer toolbar artwork

The small Back, Forward, Stop, Refresh, Home, Search, Favorites, History, Channels, Fullscreen, and Mail images in `public/assets/win98/ie-toolbar/` were cropped at native scale from a historical Windows 98 Internet Explorer training image for personal interface recreation. Reference page:

- <https://www.tech2u.com.au/training/tech2u/win98_2/internet.html>

These images are not redesigned modern icons and are not claimed to have an open-source license.

## Window behavior reference

- `1j01/os-gui`: <https://github.com/1j01/os-gui>

This project does not copy its window manager code directly. It serves as a behavioral reference for Win9x-style web window interactions such as dragging, resizing, minimizing, maximizing, and closing.

## Media service runtime

The VPS media image includes Python/FastAPI/HTTPX/Uvicorn, Node.js 22,
yt-dlp, yt-dlp-ejs, and their runtime dependencies. The default deployment also
uses the GPL-3.0-licensed `bgutil-ytdlp-pot-provider` plugin and separate provider
image. The yt-dlp default dependency group includes software under additional
terms, notably GPL-2.0-or-later Mutagen; yt-dlp-ejs bundles MIT `astring` and ISC
`meriyah` code.

The complete media-specific summary and the paths of license texts retained in
the container are documented in [`media/THIRD_PARTY_NOTICES.md`](media/THIRD_PARTY_NOTICES.md).

## 1990s web references

- `oldweb-today/oldweb-today`: <https://github.com/oldweb-today/oldweb-today>
- 88×31 and GeoCities archives were used only as visual research. Their sources and copyright terms vary, so historical webpage images are not bundled in bulk.

## Runtime software

The production containers install or run the following principal open-source
dependencies. Their upstream license texts and transitive notices remain
authoritative.

| Project | Use | License |
| --- | --- | --- |
| [Node.js](https://github.com/nodejs/node) | Control runtime and media JavaScript challenge runtime | MIT and bundled third-party licenses |
| [Express](https://github.com/expressjs/express) | Control HTTP routing | MIT |
| [ws](https://github.com/websockets/ws) | Control WebSocket server/client tests | MIT |
| [Python](https://www.python.org/) | Media runtime | PSF License |
| [FastAPI](https://github.com/fastapi/fastapi) | Media HTTP application | MIT |
| [Uvicorn](https://github.com/encode/uvicorn) | Media ASGI server | BSD-3-Clause |
| [HTTPX](https://github.com/encode/httpx) | Streaming upstream client | BSD-3-Clause |
| [AnyIO](https://github.com/agronholm/anyio) | Async cancellation and concurrency | MIT |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube metadata and progressive format resolution | Unlicense |
| [yt-dlp EJS](https://github.com/yt-dlp/ejs) | External JavaScript challenge components | Unlicense, MIT, and ISC components |
| [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) | PO-token plugin and internal HTTP sidecar | GPL-3.0 |
| [Mihomo](https://github.com/MetaCubeX/mihomo) | Private application-facing HTTP proxy over the configured VLESS Reality egress | GPL-3.0 |
| [Caddy](https://github.com/caddyserver/caddy) | TLS and reverse-proxy gateway | Apache-2.0 |

DreamStream 99 does not vendor these runtime projects into its MIT-licensed
source tree. They are installed from package indexes or referenced as container
images during a deployment. Distributors of combined images should retain all
licenses and notices supplied by those images and packages.

The media image's exact package versions, license expressions, and retained
license-file paths are recorded in [media/THIRD_PARTY_NOTICES.md](media/THIRD_PARTY_NOTICES.md).
