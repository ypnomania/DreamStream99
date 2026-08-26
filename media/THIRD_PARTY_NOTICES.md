# DreamStream99 media image: third-party notices

The media image contains third-party runtime software. This summary is not a
replacement for the complete license texts retained in Python package
`*.dist-info/licenses`, Debian `/usr/share/doc`, and the additional image paths
listed below.

## Media runtime

- Python: PSF License Agreement.
- Node.js 22: MIT License plus the licenses of components documented in Node's
  distribution license. The complete file is copied to
  `/usr/local/share/licenses/node/LICENSE` in the image.
- FastAPI and AnyIO: MIT.
- HTTPX and Uvicorn: BSD-3-Clause.
- yt-dlp 2026.08.19: The Unlicense.
- yt-dlp-ejs 0.8.0: Unlicense AND MIT AND ISC. Its bundled `astring` code is MIT
  and bundled `meriyah` code is ISC; their notices remain in the installed EJS
  scripts.

The `yt-dlp[default]` dependency group also installs runtime components under
their own terms, notably Mutagen (GPL-2.0-or-later), Requests (Apache-2.0),
certifi (MPL-2.0), PyCryptodomeX (BSD/Public Domain), urllib3 (MIT), Brotli
(MIT), and websockets (BSD-3-Clause). Their distributions retain the applicable
license/notice files in the image.

## Optional/default PO-token provider

The default VPS Compose profile uses both
`bgutil-ytdlp-pot-provider==1.3.1` and the separate
`brainicism/bgutil-ytdlp-pot-provider:1.3.1` server image. The upstream project
is GPL-3.0 licensed and is not affiliated with yt-dlp. Because the Python wheel
does not currently include its license file, the media image copies the full
GPL-3.0 text to
`/usr/local/share/licenses/bgutil-ytdlp-pot-provider/LICENSE`.

Source and license: <https://github.com/Brainicism/bgutil-ytdlp-pot-provider>

Providing a PO token does not guarantee that YouTube will accept a request.
YouTube enforcement and token/client requirements change independently of this
project.
