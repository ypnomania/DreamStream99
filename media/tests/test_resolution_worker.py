import json
from unittest.mock import patch

from media_service.resolution_worker import _resolve_request
from media_service.resolver import (
    MediaResolveError,
    ResolvedMedia,
    ResolvedProgressiveStream,
)


SOURCE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _request(url: str = SOURCE_URL) -> bytes:
    return json.dumps({"url": url}).encode("utf-8")


def test_worker_serializes_internal_resolution_without_losing_relay_headers():
    resolved = ResolvedMedia(
        provider="youtube",
        media_id="dQw4w9WgXcQ",
        title="Worker video",
        duration=10.0,
        streams=(
            ResolvedProgressiveStream(
                upstream_url="https://media.googlevideo.com/file",
                upstream_headers={"User-Agent": "agent", "Cookie": "internal"},
                format_id="18",
                width=640,
                height=360,
                fps=30.0,
                bitrate_kbps=500.0,
                size_bytes=1024,
                video_codec="avc1",
                audio_codec="mp4a",
            ),
        ),
    )
    with patch(
        "media_service.resolution_worker._resolve_youtube",
        return_value=resolved,
    ):
        envelope = _resolve_request(_request())

    assert envelope["ok"] is True
    assert envelope["result"]["media_id"] == "dQw4w9WgXcQ"
    assert envelope["result"]["streams"][0]["upstream_headers"] == {
        "User-Agent": "agent",
        "Cookie": "internal",
    }


def test_worker_returns_only_the_safe_resolver_error_contract():
    with patch(
        "media_service.resolution_worker._resolve_youtube",
        side_effect=MediaResolveError(
            "private upstream detail",
            code="youtube_auth_required",
            public_message="YouTube authentication is required for this media",
            status_code=502,
        ),
    ):
        envelope = _resolve_request(_request())

    assert envelope == {
        "ok": False,
        "error": {
            "code": "youtube_auth_required",
            "public_message": "YouTube authentication is required for this media",
            "status_code": 502,
        },
    }
    assert "private upstream detail" not in json.dumps(envelope)


def test_worker_rejects_noncanonical_or_oversized_requests_before_resolution():
    with patch("media_service.resolution_worker._resolve_youtube") as resolver:
        malformed = _resolve_request(
            _request("https://attacker.example/watch?v=dQw4w9WgXcQ")
        )
        oversized = _resolve_request(b"x" * 4_097)

    assert malformed["ok"] is False
    assert oversized["ok"] is False
    resolver.assert_not_called()
