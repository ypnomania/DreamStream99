"""One-shot, stdout-safe yt-dlp subprocess used by the media service."""

import json
import os
import re
import sys
from typing import Any
from urllib.parse import parse_qs, urlsplit


_YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_MAX_REQUEST_BYTES = 4_096


def main() -> None:
    output_fd = os.dup(sys.stdout.fileno())
    with os.fdopen(output_fd, "wb", closefd=True) as output:
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), sys.stdout.fileno())
            os.dup2(sink.fileno(), sys.stderr.fileno())
        envelope = _resolve_request(sys.stdin.buffer.read(_MAX_REQUEST_BYTES + 1))
        output.write(
            json.dumps(
                envelope,
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        output.flush()


def _resolve_request(raw_request: bytes) -> dict[str, Any]:
    # Import yt-dlp and third-party plugins only after main() has redirected the
    # worker's inherited stdout/stderr away from the private JSON protocol.
    from media_service.resolver import MediaResolveError

    try:
        if not raw_request or len(raw_request) > _MAX_REQUEST_BYTES:
            raise ValueError("invalid request size")
        request = json.loads(raw_request)
        if not isinstance(request, dict) or set(request) != {"url"}:
            raise ValueError("invalid request shape")
        source_url = request["url"]
        if not _is_canonical_youtube_url(source_url):
            raise ValueError("invalid source URL")
        result = _resolve_youtube(source_url)
        return {"ok": True, "result": _serialize_result(result)}
    except MediaResolveError as exc:
        return {
            "ok": False,
            "error": {
                "code": exc.code,
                "public_message": exc.public_message,
                "status_code": exc.status_code,
            },
        }
    except Exception:
        return {
            "ok": False,
            "error": {
                "code": "resolve_failed",
                "public_message": "Unable to resolve media",
                "status_code": 422,
            },
        }


def _is_canonical_youtube_url(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 2_048:
        return False
    try:
        parsed = urlsplit(value)
        query = parse_qs(parsed.query, keep_blank_values=True)
    except ValueError:
        return False
    ids = query.get("v")
    return (
        parsed.scheme == "https"
        and parsed.netloc == "www.youtube.com"
        and parsed.path == "/watch"
        and not parsed.fragment
        and set(query) == {"v"}
        and isinstance(ids, list)
        and len(ids) == 1
        and _YOUTUBE_ID.fullmatch(ids[0]) is not None
    )


def _resolve_youtube(source_url: str):
    from media_service.resolver import resolve_youtube

    return resolve_youtube(source_url)


def _serialize_result(result: Any) -> dict[str, Any]:
    return {
        "provider": result.provider,
        "media_id": result.media_id,
        "title": result.title,
        "duration": result.duration,
        "streams": [
            {
                "upstream_url": stream.upstream_url,
                "upstream_headers": dict(stream.upstream_headers),
                "format_id": stream.format_id,
                "width": stream.width,
                "height": stream.height,
                "fps": stream.fps,
                "bitrate_kbps": stream.bitrate_kbps,
                "size_bytes": stream.size_bytes,
                "video_codec": stream.video_codec,
                "audio_codec": stream.audio_codec,
            }
            for stream in result.streams
        ],
    }


if __name__ == "__main__":
    main()
