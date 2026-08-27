from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
from unittest.mock import patch

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import media_service.main as main_module
from media_service.main import (
    app,
    create_relay_http_client,
    get_relay_http_client,
    get_relay_sessions,
)
from media_service.relay import (
    RelayRefreshCoordinator,
    RelayRefreshCooldownError,
    RelayStreamingResponse,
)
from media_service.resolver import (
    MediaResolveError,
    ResolvedMedia,
    ResolvedProgressiveStream,
)
from media_service.sessions import RelaySessionStore, RelayStreamKey, RelayTarget


class TrackingStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class BlockingStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b"first chunk"
        await anyio.sleep_forever()

    async def aclose(self) -> None:
        self.closed = True


SOURCE_URL = "https://www.youtube.com/watch?v=video-id"
STALE_UPSTREAM_URL = "https://rr1---sn-test.googlevideo.com/stale?sig=expired"
FRESH_UPSTREAM_URL = "https://rr2---sn-test.googlevideo.com/fresh?sig=current"
MEDIA_GRANT_SECRET = "test-media-grant-secret-" + ("x" * 48)


def refreshable_target() -> RelayTarget:
    return RelayTarget(
        STALE_UPSTREAM_URL,
        (("User-Agent", "stale-agent"),),
        media_id="video-id",
        format_id="18",
        source_url=SOURCE_URL,
    )


def refreshed_media(*, format_id: str = "18") -> ResolvedMedia:
    return ResolvedMedia(
        provider="youtube",
        media_id="video-id",
        title="Refreshed video",
        duration=10.0,
        streams=(
            ResolvedProgressiveStream(
                upstream_url=FRESH_UPSTREAM_URL,
                upstream_headers={"User-Agent": "fresh-agent"},
                format_id=format_id,
                width=640,
                height=360,
                fps=30.0,
                bitrate_kbps=500.0,
                size_bytes=10,
                video_codec="avc1.42001E",
                audio_codec="mp4a.40.2",
            ),
        ),
    )


@pytest.fixture
def relay_harness(monkeypatch):
    store = RelaySessionStore()
    clients: list[httpx.AsyncClient] = []
    monkeypatch.setenv("MEDIA_GRANT_SECRET", MEDIA_GRANT_SECRET)
    monkeypatch.delenv("MEDIA_EGRESS_PROXY", raising=False)
    monkeypatch.delenv("YTDLP_PROXY", raising=False)
    app.dependency_overrides[get_relay_sessions] = lambda: store

    def install_transport(handler) -> None:
        client = create_relay_http_client(transport=httpx.MockTransport(handler))
        clients.append(client)
        app.dependency_overrides[get_relay_http_client] = lambda: client

    with TestClient(app, headers={"Origin": main_module.MEDIA_ALLOWED_ORIGIN}) as client:
        yield client, store, install_transport

    app.dependency_overrides.clear()
    for http_client in clients:
        anyio.run(http_client.aclose)


def test_relay_and_yt_dlp_share_one_authenticated_proxy(monkeypatch):
    proxy = "http://relay-user:dummy-password@proxy.example:8080"
    monkeypatch.setenv("MEDIA_EGRESS_PROXY", proxy)
    monkeypatch.delenv("YTDLP_PROXY", raising=False)

    with patch("media_service.main.httpx.AsyncClient") as client_class:
        relay_client = create_relay_http_client()

    assert relay_client is client_class.return_value
    assert client_class.call_args.kwargs["proxy"] == proxy
    assert client_class.call_args.kwargs["trust_env"] is False
    assert main_module.YtDlpSettings.from_env().youtube_dl_options()["proxy"] == proxy


def test_relay_does_not_inherit_ambient_proxy_when_unconfigured(monkeypatch):
    monkeypatch.delenv("MEDIA_EGRESS_PROXY", raising=False)
    monkeypatch.delenv("YTDLP_PROXY", raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient-user:secret@ambient.example")

    with patch("media_service.main.httpx.AsyncClient") as client_class:
        create_relay_http_client()

    assert "proxy" not in client_class.call_args.kwargs
    assert client_class.call_args.kwargs["trust_env"] is False
    assert main_module.YtDlpSettings.from_env().youtube_dl_options()["proxy"] == ""


def test_range_is_forwarded_and_206_headers_and_raw_chunks_are_relayed(relay_harness):
    client, store, install_transport = relay_harness
    seen_request: httpx.Request | None = None
    stream = TrackingStream([b"23", b"45"])

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_request
        seen_request = request
        return httpx.Response(
            206,
            headers={
                "Content-Range": "bytes 2-5/10",
                "Content-Length": "4",
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
                "Set-Cookie": "upstream=must-not-leak",
                "Server": "internal-origin",
            },
            stream=stream,
        )

    install_transport(upstream_handler)
    session = store.create(
        RelayTarget(
            "https://rr1---sn-test.googlevideo.com/videoplayback?sig=secret",
            (
                ("User-Agent", "yt-dlp-agent"),
                ("Cookie", "SID=internal"),
                ("Range", "bytes=0-0"),
                ("Host", "attacker.example"),
                ("Accept-Encoding", "gzip"),
            ),
        )
    )

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["Access-Control-Allow-Origin"] == (
        main_module.MEDIA_ALLOWED_ORIGIN
    )
    assert {
        name: response.headers[name]
        for name in (
            "Content-Range",
            "Content-Length",
            "Content-Type",
            "Accept-Ranges",
        )
    } == {
        "Content-Range": "bytes 2-5/10",
        "Content-Length": "4",
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
    }
    assert "set-cookie" not in response.headers
    assert "server" not in response.headers

    assert seen_request is not None
    assert seen_request.headers["Range"] == "bytes=2-5"
    assert seen_request.headers["Accept-Encoding"] == "identity"
    assert seen_request.headers["User-Agent"] == "yt-dlp-agent"
    assert seen_request.headers["Cookie"] == "SID=internal"
    assert seen_request.url.host.endswith(".googlevideo.com")
    assert stream.closed is True


def test_head_uses_a_validated_one_byte_probe_without_streaming_a_body(relay_harness):
    client, store, install_transport = relay_harness
    stream = TrackingStream([b"0"])
    requests: list[tuple[str, str]] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.headers["Range"]))
        return httpx.Response(
            206,
            headers={
                "Content-Range": "bytes 0-0/10",
                "Content-Length": "1",
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
                "Set-Cookie": "must-not-leak=1",
            },
            stream=stream,
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.head(
        f"/relay/{session}",
        headers={"Range": "bytes=5-7"},
    )

    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["Content-Length"] == "10"
    assert response.headers["Content-Type"] == "video/mp4"
    assert response.headers["Accept-Ranges"] == "bytes"
    assert "Content-Range" not in response.headers
    assert "Set-Cookie" not in response.headers
    assert requests == [("GET", "bytes=0-0")]
    assert stream.closed is True


def test_upstream_403_refreshes_same_format_and_retries_original_range(
    relay_harness,
):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    stale_stream = TrackingStream([b"expired response must not leak"])
    fresh_stream = TrackingStream([b"23", b"45"])
    requests: list[tuple[str, str | None, str | None]] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            (
                str(request.url),
                request.headers.get("Range"),
                request.headers.get("User-Agent"),
            )
        )
        if str(request.url) == STALE_UPSTREAM_URL:
            return httpx.Response(403, stream=stale_stream)
        if str(request.url) == FRESH_UPSTREAM_URL:
            return httpx.Response(
                206,
                headers={
                    "Content-Range": "bytes 2-5/10",
                    "Content-Length": "4",
                    "Content-Type": "video/mp4",
                    "Accept-Ranges": "bytes",
                },
                stream=fresh_stream,
            )
        raise AssertionError(f"unexpected upstream request: {request.url}")

    def resolve_while_generation_is_cas_guarded(source_url: str) -> ResolvedMedia:
        assert source_url == SOURCE_URL
        assert target.cache_key is not None
        assert store.get_cached_target(target.cache_key) == target
        return refreshed_media()

    install_transport(upstream_handler)
    session = store.create(target)

    with patch(
        "media_service.main.resolve_youtube",
        side_effect=resolve_while_generation_is_cas_guarded,
    ) as resolve_mock:
        response = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=2-5"},
        )

    assert response.status_code == 206
    assert response.content == b"2345"
    assert requests == [
        (STALE_UPSTREAM_URL, "bytes=2-5", "stale-agent"),
        (FRESH_UPSTREAM_URL, "bytes=2-5", "fresh-agent"),
    ]
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert stale_stream.closed is True
    assert fresh_stream.closed is True
    assert target.cache_key is not None
    cached_target = store.get_cached_target(target.cache_key)
    assert cached_target is not None
    assert cached_target.upstream_url == FRESH_UPSTREAM_URL
    assert cached_target.format_id == "18"


def test_concurrent_403_requests_share_one_refresh_and_keep_their_ranges(
    relay_harness,
):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    session = store.create(target)
    ranges = ("bytes=0-1", "bytes=5-7")
    bodies = {
        "bytes=0-1": ("bytes 0-1/10", b"01"),
        "bytes=5-7": ("bytes 5-7/10", b"567"),
    }
    requests: list[tuple[str, str]] = []
    forbidden_streams: list[TrackingStream] = []
    fresh_streams: list[TrackingStream] = []
    observations_lock = Lock()

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        requested_range = request.headers["Range"]
        request_url = str(request.url)
        with observations_lock:
            requests.append((request_url, requested_range))

        if request_url == STALE_UPSTREAM_URL:
            stream = TrackingStream([b"expired response must not leak"])
            with observations_lock:
                forbidden_streams.append(stream)
            return httpx.Response(403, stream=stream)

        if request_url == FRESH_UPSTREAM_URL:
            content_range, body = bodies[requested_range]
            stream = TrackingStream([body])
            with observations_lock:
                fresh_streams.append(stream)
            return httpx.Response(
                206,
                headers={
                    "Content-Range": content_range,
                    "Content-Length": str(len(body)),
                    "Content-Type": "video/mp4",
                    "Accept-Ranges": "bytes",
                },
                stream=stream,
            )

        raise AssertionError(f"unexpected upstream request: {request.url}")

    both_refresh_paths_entered = Event()
    refresh_path_count = 0
    refresh_path_lock = Lock()
    original_refresh = main_module._refresh_relay_target

    async def observe_refresh_path(*args, **kwargs):
        nonlocal refresh_path_count
        with refresh_path_lock:
            refresh_path_count += 1
            if refresh_path_count == 2:
                both_refresh_paths_entered.set()
        return await original_refresh(*args, **kwargs)

    def resolve_once(source_url: str) -> ResolvedMedia:
        assert source_url == SOURCE_URL
        assert both_refresh_paths_entered.wait(timeout=5)
        return refreshed_media()

    request_start = Barrier(3)

    def fetch(requested_range: str):
        request_start.wait(timeout=5)
        return client.get(
            f"/relay/{session}",
            headers={"Range": requested_range},
        )

    install_transport(upstream_handler)
    with (
        patch(
            "media_service.main._refresh_relay_target",
            new=observe_refresh_path,
        ),
        patch(
            "media_service.main.resolve_youtube",
            side_effect=resolve_once,
        ) as resolve_mock,
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        futures = [executor.submit(fetch, requested_range) for requested_range in ranges]
        request_start.wait(timeout=5)
        responses = [future.result(timeout=10) for future in futures]

    assert [(response.status_code, response.content) for response in responses] == [
        (206, b"01"),
        (206, b"567"),
    ]
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert refresh_path_count == 2
    assert sorted(requests) == sorted(
        [
            (STALE_UPSTREAM_URL, ranges[0]),
            (STALE_UPSTREAM_URL, ranges[1]),
            (FRESH_UPSTREAM_URL, ranges[0]),
            (FRESH_UPSTREAM_URL, ranges[1]),
        ]
    )
    assert len(forbidden_streams) == 2
    assert len(fresh_streams) == 2
    assert all(stream.closed for stream in forbidden_streams + fresh_streams)


def test_slow_old_refresh_cannot_overwrite_a_newer_resolve_generation(
    relay_harness,
):
    client, store, install_transport = relay_harness
    stale = refreshable_target()
    stale_session = store.create(stale)
    newer_url = "https://rr3---sn-test.googlevideo.com/newer?sig=resolve"
    newer = RelayTarget(
        newer_url,
        (("User-Agent", "newer-agent"),),
        media_id="video-id",
        format_id="18",
        source_url=SOURCE_URL,
    )
    requests: list[tuple[str, str | None]] = []
    streams: list[TrackingStream] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        requests.append((str(request.url), request.headers.get("User-Agent")))
        if str(request.url) == STALE_UPSTREAM_URL:
            stream = TrackingStream([b"expired"])
            streams.append(stream)
            return httpx.Response(403, stream=stream)
        if str(request.url) == newer_url:
            stream = TrackingStream([b"01"])
            streams.append(stream)
            return httpx.Response(
                206,
                headers={
                    "Content-Range": "bytes 0-1/10",
                    "Content-Length": "2",
                    "Content-Type": "video/mp4",
                    "Accept-Ranges": "bytes",
                },
                stream=stream,
            )
        raise AssertionError("the losing refresh URL must never be contacted")

    refresh_started = Event()
    release_refresh = Event()

    def slow_resolve(source_url: str) -> ResolvedMedia:
        assert source_url == SOURCE_URL
        refresh_started.set()
        assert release_refresh.wait(timeout=5)
        return refreshed_media()

    def fetch():
        return client.get(
            f"/relay/{stale_session}",
            headers={"Range": "bytes=0-1"},
        )

    install_transport(upstream_handler)
    with (
        patch("media_service.main.resolve_youtube", side_effect=slow_resolve),
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        future = executor.submit(fetch)
        assert refresh_started.wait(timeout=5)
        store.create(newer)
        release_refresh.set()
        response = future.result(timeout=10)

    assert response.status_code == 206
    assert response.content == b"01"
    assert requests == [
        (STALE_UPSTREAM_URL, "stale-agent"),
        (newer_url, "newer-agent"),
    ]
    assert stale.cache_key is not None
    assert store.get_cached_target(stale.cache_key) == newer
    assert store.get(stale_session) == newer
    assert all(stream.closed for stream in streams)


def test_different_target_revisions_do_not_share_a_refresh_flight():
    async def scenario() -> None:
        coordinator = RelayRefreshCoordinator()
        stream_key = RelayStreamKey("video-id", "18")
        both_started = anyio.Event()
        release = anyio.Event()
        results: dict[str, str] = {}
        started = 0

        async def operation(revision: str) -> str:
            nonlocal started
            started += 1
            if started == 2:
                both_started.set()
            await release.wait()
            return revision

        async def run_revision(revision: str) -> None:
            results[revision] = await coordinator.run(
                (stream_key, revision),
                lambda: operation(revision),
            )

        async with anyio.create_task_group() as task_group:
            task_group.start_soon(run_revision, "revision-a")
            task_group.start_soon(run_revision, "revision-b")
            with anyio.fail_after(1):
                await both_started.wait()
            release.set()

        assert results == {
            "revision-a": "revision-a",
            "revision-b": "revision-b",
        }
        await coordinator.aclose()

    anyio.run(scenario)


def test_refresh_deadline_enters_cooldown_without_starting_another_operation():
    async def scenario() -> None:
        coordinator = RelayRefreshCoordinator(
            timeout_seconds=0.01,
            failure_cooldown_seconds=60,
        )
        refresh_key = (RelayStreamKey("video-id", "18"), "revision")
        calls = 0

        async def never_finishes() -> None:
            nonlocal calls
            calls += 1
            await anyio.sleep_forever()

        with pytest.raises(TimeoutError):
            await coordinator.run(refresh_key, never_finishes)
        with pytest.raises(RelayRefreshCooldownError):
            await coordinator.run(refresh_key, never_finishes)
        assert calls == 1
        await coordinator.aclose()

    anyio.run(scenario)


def test_a_second_upstream_403_is_not_retried_or_forwarded(relay_harness):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    first_forbidden = TrackingStream([b"expired-secret"])
    second_forbidden = TrackingStream([b"refresh-secret"])
    requests: list[tuple[str, str | None]] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        requests.append((str(request.url), request.headers.get("Range")))
        if len(requests) == 1:
            return httpx.Response(403, stream=first_forbidden)
        if len(requests) == 2:
            return httpx.Response(403, stream=second_forbidden)
        raise AssertionError("a refreshed 403 must not trigger another retry")

    install_transport(upstream_handler)
    session = store.create(target)

    with patch(
        "media_service.main.resolve_youtube",
        return_value=refreshed_media(),
    ) as resolve_mock:
        response = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=7-"},
        )

    assert response.status_code == 502
    assert requests == [
        (STALE_UPSTREAM_URL, "bytes=7-"),
        (FRESH_UPSTREAM_URL, "bytes=7-"),
    ]
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert first_forbidden.closed is True
    assert second_forbidden.closed is True
    assert target.cache_key is not None
    assert store.get_cached_target(target.cache_key) is None
    assert "expired-secret" not in response.text
    assert "refresh-secret" not in response.text
    assert "googlevideo" not in response.text


def test_a_refreshed_403_generation_is_cooled_down_across_requests(
    relay_harness,
):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    contacted_urls: list[str] = []
    forbidden_streams: list[TrackingStream] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        contacted_urls.append(str(request.url))
        stream = TrackingStream([b"must-not-leak"])
        forbidden_streams.append(stream)
        return httpx.Response(403, stream=stream)

    install_transport(upstream_handler)
    session = store.create(target)

    with patch(
        "media_service.main.resolve_youtube",
        return_value=refreshed_media(),
    ) as resolve_mock:
        first = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )
        second = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )

    assert first.status_code == second.status_code == 502
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert contacted_urls == [
        STALE_UPSTREAM_URL,
        FRESH_UPSTREAM_URL,
        FRESH_UPSTREAM_URL,
    ]
    assert all(stream.closed for stream in forbidden_streams)


def test_403_refresh_failure_returns_generic_502_without_leaking_details(
    relay_harness,
):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    forbidden_stream = TrackingStream([b"forbidden-body-secret"])
    contacted_urls: list[str] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        contacted_urls.append(str(request.url))
        return httpx.Response(403, stream=forbidden_stream)

    install_transport(upstream_handler)
    session = store.create(target)
    resolver_error = MediaResolveError(
        "refresh failed for https://secret.googlevideo.com/?token=resolver-secret"
    )

    with patch(
        "media_service.main.resolve_youtube",
        side_effect=resolver_error,
    ) as resolve_mock:
        response = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )

    assert response.status_code == 502
    assert contacted_urls == [STALE_UPSTREAM_URL]
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert forbidden_stream.closed is True
    assert target.cache_key is not None
    assert store.get_cached_target(target.cache_key) is None
    for secret in ("googlevideo", "resolver-secret", "forbidden-body-secret"):
        assert secret not in response.text


def test_failed_generation_refresh_is_cooled_down_between_requests(relay_harness):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    forbidden_streams: list[TrackingStream] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        stream = TrackingStream([b"secret"])
        forbidden_streams.append(stream)
        return httpx.Response(403, stream=stream)

    install_transport(upstream_handler)
    session = store.create(target)
    with patch(
        "media_service.main.resolve_youtube",
        side_effect=MediaResolveError("still forbidden"),
    ) as resolve_mock:
        first = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )
        second = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )

    assert first.status_code == second.status_code == 502
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert len(forbidden_streams) == 2
    assert all(stream.closed for stream in forbidden_streams)


def test_403_refresh_missing_original_format_returns_generic_502(
    relay_harness,
):
    client, store, install_transport = relay_harness
    target = refreshable_target()
    forbidden_stream = TrackingStream([b"forbidden-body-secret"])
    contacted_urls: list[str] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        contacted_urls.append(str(request.url))
        return httpx.Response(403, stream=forbidden_stream)

    install_transport(upstream_handler)
    session = store.create(target)

    with patch(
        "media_service.main.resolve_youtube",
        return_value=refreshed_media(format_id="22"),
    ) as resolve_mock:
        response = client.get(
            f"/relay/{session}",
            headers={"Range": "bytes=0-1"},
        )

    assert response.status_code == 502
    assert contacted_urls == [STALE_UPSTREAM_URL]
    resolve_mock.assert_called_once_with(SOURCE_URL)
    assert forbidden_stream.closed is True
    assert target.cache_key is not None
    assert store.get_cached_target(target.cache_key) is None
    assert "googlevideo" not in response.text
    assert "forbidden-body-secret" not in response.text


@pytest.mark.parametrize(
    ("range_header", "content_range", "body"),
    [
        ("bytes=7-", "bytes 7-9/10", b"789"),
        ("bytes=-3", "bytes 7-9/10", b"789"),
        ("bytes=0-999", "bytes 0-9/10", b"0123456789"),
    ],
)
def test_open_ended_suffix_and_truncated_ranges(
    relay_harness,
    range_header,
    content_range,
    body,
):
    client, store, install_transport = relay_harness

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Range"] == range_header
        return httpx.Response(
            206,
            headers={
                "Content-Range": content_range,
                "Content-Length": str(len(body)),
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
            },
            stream=TrackingStream([body]),
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": range_header},
    )

    assert response.status_code == 206
    assert response.content == body


@pytest.mark.parametrize(
    "range_header",
    [None, "items=0-1", "bytes=", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5"],
)
def test_invalid_or_multiple_ranges_are_rejected_without_contacting_upstream(
    relay_harness,
    range_header,
):
    client, store, install_transport = relay_harness
    contacted = False

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        nonlocal contacted
        contacted = True
        raise AssertionError("invalid ranges must not contact the upstream")

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))
    headers = {"Range": range_header} if range_header is not None else {}

    response = client.get(f"/relay/{session}", headers=headers)

    assert response.status_code == 416
    assert response.headers["Accept-Ranges"] == "bytes"
    assert contacted is False


def test_duplicate_range_headers_are_rejected(relay_harness):
    client, store, install_transport = relay_harness
    contacted = False

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        nonlocal contacted
        contacted = True
        raise AssertionError("duplicate Range headers must not reach upstream")

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers=[("Range", "bytes=0-1"), ("Range", "bytes=2-3")],
    )

    assert response.status_code == 416
    assert contacted is False


def test_unknown_session_is_not_resolved(relay_harness):
    client, _, install_transport = relay_harness

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an unknown session must not contact the upstream")

    install_transport(upstream_handler)
    response = client.get(
        "/relay/not-a-real-session",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 404


def test_relay_requires_the_allowed_origin_before_session_lookup(relay_harness):
    client, _, _ = relay_harness
    missing = TestClient(app).get(
        "/relay/not-a-real-session",
        headers={"Range": "bytes=0-1"},
    )
    wrong = client.head(
        "/relay/not-a-real-session",
        headers={"Origin": "https://attacker.example"},
    )
    assert missing.status_code == wrong.status_code == 403
    assert missing.json()["detail"]["code"] == "origin_not_allowed"


def test_non_googlevideo_internal_target_is_rejected(relay_harness):
    client, store, install_transport = relay_harness
    contacted = False

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        nonlocal contacted
        contacted = True
        raise AssertionError("an invalid internal target must not be requested")

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://internal.example/secret"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 502
    assert contacted is False


def test_upstream_200_is_not_mislabeled_as_partial_content(relay_harness):
    client, store, install_transport = relay_harness
    stream = TrackingStream([b"full response"])

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            stream=stream,
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 502
    assert stream.closed is True


def test_upstream_open_timeout_returns_a_stable_504(relay_harness):
    client, store, install_transport = relay_harness

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private upstream detail", request=request)

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))
    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 504
    assert response.json() == {
        "detail": {"code": "relay_timeout", "message": "Upstream timed out"}
    }
    assert "private upstream detail" not in response.text


def test_inconsistent_upstream_range_headers_are_rejected(relay_harness):
    client, store, install_transport = relay_harness
    stream = TrackingStream([b"wrong"])

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            206,
            headers={
                "Content-Range": "bytes 0-4/10",
                "Content-Length": "5",
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
            },
            stream=stream,
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 502
    assert stream.closed is True


@pytest.mark.parametrize(
    "extra_headers",
    [
        {"Content-Type": "text/html"},
        {"Content-Encoding": "gzip"},
    ],
)
def test_non_mp4_or_encoded_partial_responses_are_rejected(
    relay_harness,
    extra_headers,
):
    client, store, install_transport = relay_harness
    stream = TrackingStream([b"01"])

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        headers = {
            "Content-Range": "bytes 0-1/10",
            "Content-Length": "2",
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
        }
        headers.update(extra_headers)
        return httpx.Response(206, headers=headers, stream=stream)

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 502
    assert stream.closed is True


def test_upstream_response_cookies_do_not_cross_relay_sessions(relay_harness):
    client, store, install_transport = relay_harness
    seen_cookies: list[str | None] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        seen_cookies.append(request.headers.get("Cookie"))
        return httpx.Response(
            206,
            headers={
                "Content-Range": "bytes 0-1/10",
                "Content-Length": "2",
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
                "Set-Cookie": "origin_state=private; Domain=.googlevideo.com; Path=/",
            },
            stream=TrackingStream([b"01"]),
        )

    install_transport(upstream_handler)
    first = store.create(RelayTarget("https://media.googlevideo.com/first"))
    second = store.create(RelayTarget("https://media.googlevideo.com/second"))

    first_response = client.get(
        f"/relay/{first}",
        headers={"Range": "bytes=0-1"},
    )
    second_response = client.get(
        f"/relay/{second}",
        headers={"Range": "bytes=0-1"},
    )

    assert first_response.status_code == 206
    assert second_response.status_code == 206
    assert seen_cookies == [None, None]


def test_upstream_redirects_are_not_followed(relay_harness):
    client, store, install_transport = relay_harness
    contacted_urls: list[str] = []

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        contacted_urls.append(str(request.url))
        return httpx.Response(
            302,
            headers={"Location": "https://attacker.example/collect"},
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 502
    assert contacted_urls == ["https://media.googlevideo.com/video"]


def test_upstream_416_is_forwarded_with_unsatisfied_content_range(relay_harness):
    client, store, install_transport = relay_harness

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            416,
            headers={
                "Content-Range": "bytes */10",
                "Accept-Ranges": "bytes",
            },
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=20-30"},
    )

    assert response.status_code == 416
    assert response.headers["Content-Range"] == "bytes */10"
    assert response.headers["Accept-Ranges"] == "bytes"


def test_invalid_upstream_416_metadata_is_not_forwarded(relay_harness):
    client, store, install_transport = relay_harness

    def upstream_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            416,
            headers={
                "Content-Range": "https://secret.googlevideo.com/internal-url",
                "Accept-Ranges": "bytes",
            },
        )

    install_transport(upstream_handler)
    session = store.create(RelayTarget("https://media.googlevideo.com/video"))

    response = client.get(
        f"/relay/{session}",
        headers={"Range": "bytes=20-30"},
    )

    assert response.status_code == 502
    assert "googlevideo" not in response.text


def test_client_send_failure_closes_the_active_upstream_immediately():
    stream = TrackingStream([b"first chunk", b"second chunk"])
    request = httpx.Request("GET", "https://media.googlevideo.com/video")
    upstream = httpx.Response(206, request=request, stream=stream)
    response = RelayStreamingResponse(
        upstream,
        headers={
            "Content-Range": "bytes 0-21/100",
            "Content-Length": "22",
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
        },
    )
    sent_body = False

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        nonlocal sent_body
        if message["type"] == "http.response.body":
            sent_body = True
            raise OSError("client disconnected")

    async def run_response() -> None:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/relay/session",
            "raw_path": b"/relay/session",
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }
        with pytest.raises(ClientDisconnect):
            await response(scope, receive, send)

    anyio.run(run_response)
    assert sent_body is True
    assert stream.closed is True


def test_asgi_disconnect_cancellation_closes_the_active_upstream_immediately():
    stream = BlockingStream()
    request = httpx.Request("GET", "https://media.googlevideo.com/video")
    upstream = httpx.Response(206, request=request, stream=stream)
    response = RelayStreamingResponse(
        upstream,
        headers={
            "Content-Range": "bytes 0-10/100",
            "Content-Length": "11",
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
        },
    )

    async def run_response() -> None:
        first_body_sent = anyio.Event()

        async def receive():
            await first_body_sent.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                first_body_sent.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/relay/session",
            "raw_path": b"/relay/session",
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }
        await response(scope, receive, send)

    anyio.run(run_response)
    assert stream.closed is True
