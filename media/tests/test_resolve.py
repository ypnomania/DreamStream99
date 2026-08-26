import base64
import hashlib
import hmac
import json
import os
import time
from time import perf_counter
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from yt_dlp.utils import DownloadError

from media_service.main import MEDIA_ALLOWED_ORIGIN, app


MEDIA_GRANT_SECRET = "test-media-grant-secret-kept-separate-and-long"
TEST_MEDIA = {"provider": "youtube", "id": "dQw4w9WgXcQ"}
TEST_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
client = TestClient(app, headers={"Origin": MEDIA_ALLOWED_ORIGIN})


@pytest.fixture(autouse=True)
def clean_service_state(monkeypatch):
    app.state.relay_sessions.clear()
    app.state.media_grant_secret = MEDIA_GRANT_SECRET.encode("utf-8")
    monkeypatch.setenv("MEDIA_GRANT_SECRET", MEDIA_GRANT_SECRET)
    client.headers["Authorization"] = f"Bearer {_media_grant()}"
    for name in (
        "YTDLP_COOKIEFILE",
        "YTDLP_PO_TOKEN_PROVIDER",
        "YTDLP_PROXY",
        "YTDLP_SOCKET_TIMEOUT",
    ):
        monkeypatch.delenv(name, raising=False)
    yield
    app.state.relay_sessions.clear()
    app.dependency_overrides.clear()


def _media_grant(
    *,
    media: dict[str, str] | None = None,
    issued_at: int | None = None,
    expires_at: int | None = None,
) -> str:
    selected_media = TEST_MEDIA if media is None else media
    iat = int(time.time()) if issued_at is None else issued_at
    exp = iat + 120 if expires_at is None else expires_at
    claims = {
        "v": 1,
        "type": "media-grant",
        "iss": "dreamstream99-control",
        "aud": "dreamstream99-media",
        "roomId": "ABCD2345",
        "subject": "11111111-1111-4111-8111-111111111111",
        "role": "guest",
        "media": selected_media,
        "jti": "22222222-2222-4222-8222-222222222222",
        "iat": iat,
        "exp": exp,
    }
    payload = _base64url(
        json.dumps(claims, separators=(",", ":")).encode("utf-8")
    )
    message = (
        b"DreamStream99.MediaGrant.HMAC-SHA256.v1\0"
        + f"mg1.{payload}".encode("ascii")
    )
    signature = hmac.digest(
        MEDIA_GRANT_SECRET.encode("utf-8"),
        message,
        hashlib.sha256,
    )
    return f"mg1.{payload}.{_base64url(signature)}"


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _format(
    format_id: str,
    *,
    url: str | None = None,
    ext: str = "mp4",
    protocol: str = "https",
    video_codec: str = "avc1.42001E",
    audio_codec: str = "mp4a.40.2",
    height: int = 360,
    manifest_url: str | None = None,
    http_headers: dict[str, str] | None = None,
) -> dict:
    result = {
        "format_id": format_id,
        "url": url
        or f"https://rr1---sn-test.googlevideo.com/videoplayback?id={format_id}",
        "ext": ext,
        "protocol": protocol,
        "vcodec": video_codec,
        "acodec": audio_codec,
        "width": round(height * 16 / 9),
        "height": height,
        "fps": 30,
        "tbr": 900.5,
        "filesize": 123456,
        "filesize_approx": 999999,
    }
    if manifest_url:
        result["manifest_url"] = manifest_url
    if http_headers:
        result["http_headers"] = http_headers
    return result


def _info(**overrides) -> dict:
    result = {
        "id": TEST_MEDIA["id"],
        "title": "Resolver test video",
        "duration": 123,
        "thumbnail": "https://img.example/thumbnail.jpg",
        "description": "must not escape the internal resolver",
        "formats": [],
        "http_headers": {"User-Agent": "yt-dlp-agent"},
    }
    result.update(overrides)
    return result


def _post_with_result(result_or_error, record_property):
    with patch("media_service.resolver.YoutubeDL") as ydl_class:
        ydl = ydl_class.return_value.__enter__.return_value
        if isinstance(result_or_error, Exception):
            ydl.extract_info.side_effect = result_or_error
        else:
            ydl.extract_info.return_value = result_or_error

        started = perf_counter()
        response = client.post("/resolve", json={"media": TEST_MEDIA})
        elapsed = perf_counter() - started

        record_property("elapsed_seconds", round(elapsed, 6))
        assert elapsed < 1.0
        ydl.extract_info.assert_called_once_with(TEST_URL, download=False)
        return response, ydl_class


def test_contract_is_exact_and_upstream_state_stays_internal(record_property):
    upstream_url = (
        "https://rr1---sn-secret.googlevideo.com/videoplayback?sig=secret-token"
    )
    formats = [
        _format("18", height=360),
        _format(
            "22",
            url=upstream_url,
            height=720,
            http_headers={"Cookie": "SID=internal-only"},
        ),
        _format("137", height=1080, audio_codec="none"),
        _format("140", ext="m4a", video_codec="none"),
        _format(
            "hls-720",
            url="https://manifest.googlevideo.com/master.m3u8",
            protocol="m3u8_native",
            height=720,
        ),
        _format("webm-muxed", ext="webm", video_codec="vp9", audio_codec="opus"),
        _format("foreign-mp4", url="https://internal.example/private.mp4"),
    ]

    response, ydl_class = _post_with_result(_info(formats=formats), record_property)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"media", "metadata", "streams"}
    assert body["media"] == TEST_MEDIA
    assert body["metadata"] == {
        "title": "Resolver test video",
        "duration": 123.0,
    }
    assert len(body["streams"]) == 2

    first_stream = body["streams"][0]
    assert set(first_stream) == {
        "session",
        "relay_url",
        "delivery",
        "container",
        "mime_type",
        "supports_byte_ranges",
        "width",
        "height",
        "fps",
        "bitrate_kbps",
        "size_bytes",
        "video_codec",
        "audio_codec",
    }
    assert first_stream == {
        "session": first_stream["session"],
        "relay_url": f"/relay/{first_stream['session']}",
        "delivery": "progressive",
        "container": "mp4",
        "mime_type": "video/mp4",
        "supports_byte_ranges": True,
        "width": 1280,
        "height": 720,
        "fps": 30.0,
        "bitrate_kbps": 900.5,
        "size_bytes": 123456,
        "video_codec": "avc1.42001E",
        "audio_codec": "mp4a.40.2",
    }

    serialized = response.text
    for forbidden in (
        "googlevideo",
        "secret-token",
        "SID=internal-only",
        "thumbnail",
        "description",
        "format_id",
        "manifest",
        "hls",
    ):
        assert forbidden not in serialized

    relay_target = app.state.relay_sessions.get(first_stream["session"])
    assert relay_target is not None
    assert relay_target.upstream_url == upstream_url
    assert relay_target.media_id == TEST_MEDIA["id"]
    assert relay_target.format_id == "22"
    assert relay_target.source_url == (
        TEST_URL
    )
    assert dict(relay_target.request_headers) == {
        "User-Agent": "yt-dlp-agent",
        "Cookie": "SID=internal-only",
    }

    options = ydl_class.call_args.args[0]
    assert options["skip_download"] is True
    assert options["noplaylist"] is True


def test_hls_and_dash_only_media_returns_no_stream_capabilities(record_property):
    response, _ = _post_with_result(
        _info(
            duration=None,
            formats=[
                _format(
                    "hls-live",
                    url="https://manifest.googlevideo.com/master.m3u8",
                    protocol="m3u8_native",
                ),
                _format("dash-video", protocol="http_dash_segments", audio_codec="none"),
                _format("dash-audio", ext="m4a", video_codec="none"),
            ],
        ),
        record_property,
    )

    assert response.status_code == 200
    assert response.json() == {
        "media": TEST_MEDIA,
        "metadata": {"title": "Resolver test video", "duration": None},
        "streams": [],
    }


def test_cookie_and_generic_po_token_provider_are_read_from_environment(
    record_property,
):
    with patch.dict(
        os.environ,
        {
            "YTDLP_COOKIEFILE": "/run/secrets/youtube-cookies.txt",
            "YTDLP_PO_TOKEN_PROVIDER": (
                "youtubepot-bgutilhttp:base_url=http://pot-provider:4416"
            ),
        },
    ):
        response, ydl_class = _post_with_result(
            _info(formats=[_format("18")]),
            record_property,
        )

    assert response.status_code == 200
    options = ydl_class.call_args.args[0]
    assert options["cookiefile"] == "/run/secrets/youtube-cookies.txt"
    assert options["extractor_args"] == {
        "youtube": {"player_client": ["web"]},
        "youtubepot-bgutilhttp": {
            "base_url": ["http://pot-provider:4416"],
        },
    }


def test_url_scoped_yt_dlp_cookies_are_kept_only_in_the_relay_session(
    record_property,
):
    upstream_url = "https://media.googlevideo.com/videoplayback?scope=cookie-test"
    with patch("media_service.resolver.YoutubeDL") as ydl_class:
        ydl = ydl_class.return_value.__enter__.return_value
        ydl.extract_info.return_value = _info(
            formats=[_format("18", url=upstream_url)]
        )
        ydl.cookiejar.get_cookie_header.return_value = "SID=scoped-cookie"

        response = client.post("/resolve", json={"media": TEST_MEDIA})

    assert response.status_code == 200
    assert "scoped-cookie" not in response.text
    session = response.json()["streams"][0]["session"]
    target = app.state.relay_sessions.get(session)
    assert target is not None
    assert dict(target.request_headers)["Cookie"] == "SID=scoped-cookie"


def test_resolver_errors_are_generic_and_do_not_leak_upstream_details(record_property):
    response, _ = _post_with_result(
        DownloadError(
            "ERROR: https://secret.googlevideo.com/videoplayback?token=do-not-leak"
        ),
        record_property,
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "resolve_failed",
            "message": "Unable to resolve media",
        }
    }
    assert "googlevideo" not in response.text
    assert "do-not-leak" not in response.text


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"media": None},
        {"media": {"provider": "vimeo", "id": TEST_MEDIA["id"]}},
        {"media": {"provider": "youtube", "id": "too-short"}},
        {"media": TEST_MEDIA, "unexpected": True},
        {"media": {**TEST_MEDIA, "unexpected": True}},
    ],
)
def test_request_validation_rejects_invalid_payloads(payload):
    assert client.post("/resolve", json=payload).status_code == 422


def test_only_contract_routes_are_exposed():
    public_paths = {route.path for route in app.routes}
    assert public_paths == {
        "/healthz",
        "/resolve",
        "/relay/{session}",
    }


def test_healthz_reports_process_readiness_without_media_dependencies():
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Basic abc",
        "Bearer not-a-grant",
        f"Bearer {_media_grant(issued_at=1, expires_at=2)}",
        f"Bearer {_media_grant(issued_at=int(time.time()) + 60)}",
    ],
)
def test_missing_malformed_expired_or_future_grants_fail_before_resolve(
    authorization,
):
    headers = {"Authorization": authorization} if authorization else {}
    with patch("media_service.main.resolve_youtube") as resolver:
        response = TestClient(app).post(
            "/resolve",
            json={"media": TEST_MEDIA},
            headers={"Origin": MEDIA_ALLOWED_ORIGIN, **headers},
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "invalid_media_grant"
    assert response.headers["Cache-Control"] == "no-store"
    resolver.assert_not_called()


def test_media_grant_is_bound_to_the_exact_request_media():
    other_media = {"provider": "youtube", "id": "M7lc1UVf-VE"}
    with patch("media_service.main.resolve_youtube") as resolver:
        response = client.post(
            "/resolve",
            json={"media": other_media},
            headers={"Authorization": f"Bearer {_media_grant()}"},
        )

    assert response.status_code == 401
    resolver.assert_not_called()


def test_duplicate_authorization_headers_are_rejected():
    token = _media_grant()
    response = client.post(
        "/resolve",
        json={"media": TEST_MEDIA},
        headers=[
            ("Authorization", f"Bearer {token}"),
            ("Authorization", f"Bearer {token}"),
        ],
    )

    assert response.status_code == 401


def test_resolver_identity_mismatch_is_rejected_without_creating_sessions(
    record_property,
):
    response, _ = _post_with_result(
        _info(id="M7lc1UVf-VE", formats=[_format("18")]),
        record_property,
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "resolve_failed"


def test_cors_allows_only_the_github_pages_origin(record_property):
    allowed_preflight = client.options(
        "/resolve",
        headers={
            "Origin": MEDIA_ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": (
                "Authorization, Content-Type, Range, If-Range"
            ),
        },
    )
    rejected = client.get(
        "/healthz",
        headers={"Origin": "https://attacker.example"},
    )
    allowed_response, _ = _post_with_result(
        _info(formats=[]),
        record_property,
    )

    assert allowed_preflight.status_code == 200
    assert allowed_preflight.headers["Access-Control-Allow-Origin"] == MEDIA_ALLOWED_ORIGIN
    allowed_headers = allowed_preflight.headers["Access-Control-Allow-Headers"].lower()
    assert "range" in allowed_headers
    assert "if-range" in allowed_headers
    assert rejected.status_code == 403
    assert "Access-Control-Allow-Origin" not in rejected.headers
    # Add Origin explicitly for an actual simple request, not only preflight.
    with patch("media_service.resolver.YoutubeDL") as ydl_class:
        ydl_class.return_value.__enter__.return_value.extract_info.return_value = _info()
        actual = client.post(
            "/resolve",
            json={"media": TEST_MEDIA},
            headers={"Origin": MEDIA_ALLOWED_ORIGIN},
        )
    assert actual.headers["Access-Control-Allow-Origin"] == MEDIA_ALLOWED_ORIGIN
    assert allowed_response.status_code == 200


def test_resolve_requires_the_allowed_origin_even_with_a_valid_grant():
    with patch("media_service.main.resolve_youtube") as resolver:
        missing = TestClient(app).post(
            "/resolve",
            json={"media": TEST_MEDIA},
            headers={"Authorization": f"Bearer {_media_grant()}"},
        )
        wrong = client.post(
            "/resolve",
            json={"media": TEST_MEDIA},
            headers={"Origin": "https://attacker.example"},
        )

    assert missing.status_code == wrong.status_code == 403
    assert missing.json()["detail"]["code"] == "origin_not_allowed"
    assert wrong.json()["detail"]["code"] == "origin_not_allowed"
    resolver.assert_not_called()


def test_healthz_remains_available_without_an_origin_header():
    response = TestClient(app).get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
