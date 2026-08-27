import os
import re
from contextlib import asynccontextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any
from urllib.parse import urlencode

import anyio
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from media_service.config import (
    ConfigurationError,
    MediaGrantSettings,
    MediaOriginSettings,
    RelayRefreshSettings,
    YtDlpSettings,
)
from media_service.cookiefile import (
    CookieFilePreparationError,
    prepare_runtime_cookiefile,
)
from media_service.media_auth import MediaGrantMedia, verify_media_grant
from media_service.relay import (
    ByteRange,
    InvalidByteRange,
    InvalidUpstreamResponse,
    RelayRefreshCoordinator,
    RelayStreamingResponse,
    close_upstream,
    parse_byte_range,
    upstream_request_headers,
    validated_head_headers,
    validated_relay_headers,
    validated_unsatisfied_range_headers,
)
from media_service.resolver import MediaResolveError, resolve_youtube
from media_service.schemas import (
    MediaIdentity,
    MediaMetadata,
    ResolveRequest,
    ResolveResponse,
    StreamCapability,
)
from media_service.sessions import (
    RelaySessionStore,
    RelayTarget,
    is_allowed_upstream_url,
)


class RelayRefreshError(Exception):
    """The expired upstream target could not be refreshed safely."""


MEDIA_ALLOWED_ORIGIN = MediaOriginSettings.from_env().allowed_origin
_BEARER_GRANT = re.compile(r"Bearer ([A-Za-z0-9._~-]{20,2048})", re.IGNORECASE)


class _RejectAllCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request) -> bool:
        return False

    def return_ok(self, cookie, request) -> bool:
        return False


def create_relay_http_client(
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    proxy = os.getenv("YTDLP_PROXY")
    proxy = proxy.strip() if proxy else None
    client_options: dict[str, Any] = {
        "cookies": CookieJar(policy=_RejectAllCookies()),
        "follow_redirects": False,
        "timeout": httpx.Timeout(
            connect=10.0,
            read=30.0,
            write=10.0,
            pool=10.0,
        ),
        "transport": transport,
        "trust_env": proxy is None,
    }
    if proxy is not None and transport is None:
        client_options["proxy"] = proxy
    return httpx.AsyncClient(**client_options)


@asynccontextmanager
async def lifespan(application: FastAPI):
    try:
        grant_settings = MediaGrantSettings.from_env()
        refresh_settings = RelayRefreshSettings.from_env()
        # Validate the player-client/provider grammar before advertising
        # readiness. The per-request resolver rebuilds the options so runtime
        # cookie staging remains visible without retaining secret values here.
        YtDlpSettings.from_env().youtube_dl_options()
        prepare_runtime_cookiefile()
    except (ConfigurationError, CookieFilePreparationError) as exc:
        raise RuntimeError("media service initialization failed") from exc
    async with create_relay_http_client() as relay_http_client:
        refresh_coordinator = RelayRefreshCoordinator(
            max_concurrent_refreshes=refresh_settings.max_concurrent_refreshes,
            timeout_seconds=refresh_settings.timeout_seconds,
            failure_cooldown_seconds=refresh_settings.failure_cooldown_seconds,
        )
        application.state.relay_http_client = relay_http_client
        application.state.relay_refresh_coordinator = refresh_coordinator
        application.state.media_grant_secret = grant_settings.secret.encode("utf-8")
        try:
            yield
        finally:
            await refresh_coordinator.aclose()


app = FastAPI(
    title="DreamStream Media Resolver PoC",
    version="0.2.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.state.relay_sessions = RelaySessionStore()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[MEDIA_ALLOWED_ORIGIN],
    allow_credentials=False,
    allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Range", "If-Range"],
    expose_headers=[
        "Accept-Ranges",
        "Content-Length",
        "Content-Range",
        "Content-Type",
    ],
    max_age=600,
)


@app.middleware("http")
async def reject_disallowed_origins(request: Request, call_next):
    origins = request.headers.getlist("origin")
    protected = (
        request.url.path == "/resolve"
        or request.url.path.startswith("/relay/")
    )
    origin_is_invalid = len(origins) != 1 or origins[0] != MEDIA_ALLOWED_ORIGIN
    if (protected and origin_is_invalid) or (
        not protected and origins and origin_is_invalid
    ):
        return JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "code": "origin_not_allowed",
                    "message": "Origin is not allowed",
                }
            },
            headers={"Cache-Control": "no-store"},
        )
    response = await call_next(request)
    if request.url.path == "/resolve" or request.url.path.startswith("/relay/"):
        response.headers.setdefault("Cache-Control", "private, no-store")
    return response


def get_relay_sessions(request: Request) -> RelaySessionStore:
    return request.app.state.relay_sessions


def get_relay_http_client(request: Request) -> httpx.AsyncClient:
    client = getattr(request.app.state, "relay_http_client", None)
    if client is None:
        raise HTTPException(
            status_code=503,
            detail={"code": "relay_unavailable", "message": "Relay is unavailable"},
        )
    return client


def get_relay_refresh_coordinator(request: Request) -> RelayRefreshCoordinator:
    coordinator = getattr(request.app.state, "relay_refresh_coordinator", None)
    if coordinator is None:
        raise HTTPException(
            status_code=503,
            detail={"code": "relay_unavailable", "message": "Relay is unavailable"},
        )
    return coordinator


def get_media_grant_secret(request: Request) -> bytes:
    secret = getattr(request.app.state, "media_grant_secret", None)
    if not isinstance(secret, bytes):
        raise HTTPException(
            status_code=503,
            detail={"code": "media_unavailable", "message": "Media is unavailable"},
        )
    return secret


def _extract_media_grant(request: Request) -> str | None:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        return None
    match = _BEARER_GRANT.fullmatch(values[0].strip())
    return match.group(1) if match else None


def _canonical_youtube_url(media_id: str) -> str:
    return f"https://www.youtube.com/watch?{urlencode({'v': media_id})}"


async def _open_upstream(
    relay_http_client: httpx.AsyncClient,
    target: RelayTarget,
    requested_range: ByteRange,
) -> httpx.Response:
    if not is_allowed_upstream_url(target.upstream_url):
        raise httpx.InvalidURL("invalid upstream target")
    upstream_request = relay_http_client.build_request(
        "GET",
        target.upstream_url,
        headers=upstream_request_headers(target, requested_range),
    )
    return await relay_http_client.send(upstream_request, stream=True)


async def _refresh_relay_target(
    failed_target: RelayTarget,
    sessions: RelaySessionStore,
    coordinator: RelayRefreshCoordinator,
) -> RelayTarget:
    key = failed_target.cache_key
    if key is None or failed_target.source_url is None:
        raise RelayRefreshError("the relay session has no refresh identity")

    async def refresh_once() -> RelayTarget:
        current = sessions.get_cached_target(key)
        if current is not None and current.revision != failed_target.revision:
            # A slower 403 arrived after another request already published a new
            # URL. Reuse it and do not erase or re-resolve the fresh generation.
            return current

        expected = current
        source_url = _canonical_youtube_url(key.media_id)
        try:
            result = await anyio.to_thread.run_sync(
                resolve_youtube,
                source_url,
                abandon_on_cancel=True,
            )
        except Exception as exc:
            if expected is not None:
                sessions.invalidate_target(key, expected=expected)
            raise RelayRefreshError("yt-dlp refresh failed") from exc

        if result.provider != "youtube" or result.media_id != key.media_id:
            raise RelayRefreshError("yt-dlp returned a different media identity")
        matching_streams = tuple(
            stream for stream in result.streams if stream.format_id == key.format_id
        )
        if len(matching_streams) != 1:
            raise RelayRefreshError("the original media format is unavailable")

        stream = matching_streams[0]
        if not is_allowed_upstream_url(stream.upstream_url):
            raise RelayRefreshError("yt-dlp returned an invalid upstream target")
        refreshed_target = RelayTarget.from_parts(
            stream.upstream_url,
            stream.upstream_headers,
            media_id=key.media_id,
            format_id=key.format_id,
            source_url=source_url,
        )
        published = sessions.compare_and_store_target(
            refreshed_target,
            expected=expected,
        )
        return published or refreshed_target

    try:
        return await coordinator.run(
            (key, failed_target.revision),
            refresh_once,
        )
    except RelayRefreshError:
        sessions.invalidate_target(key, expected=failed_target)
        raise
    except Exception as exc:
        sessions.invalidate_target(key, expected=failed_target)
        raise RelayRefreshError("relay refresh coordination failed") from exc


async def _open_upstream_with_refresh(
    relay_http_client: httpx.AsyncClient,
    target: RelayTarget,
    requested_range: ByteRange,
    sessions: RelaySessionStore,
    refresh_coordinator: RelayRefreshCoordinator,
) -> tuple[httpx.Response, RelayTarget]:
    """Open an upstream response and refresh once after an origin 403."""

    try:
        upstream = await _open_upstream(
            relay_http_client,
            target,
            requested_range,
        )
        if upstream.status_code == 403:
            # Do not read or expose the forbidden response. No ASGI response has
            # been started yet, so refresh latency is transparent to the browser.
            await close_upstream(upstream)
            target = await _refresh_relay_target(
                target,
                sessions,
                refresh_coordinator,
            )
            upstream = await _open_upstream(
                relay_http_client,
                target,
                requested_range,
            )
    except RelayRefreshError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Unable to refresh upstream"},
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail={"code": "relay_timeout", "message": "Upstream timed out"},
        ) from exc
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Upstream request failed"},
        ) from exc

    if upstream.status_code == 403:
        # The one permitted refresh/retry has been exhausted. Forget this
        # generation so it cannot be reused as a known-forbidden current URL.
        await close_upstream(upstream)
        if target.cache_key is not None:
            await refresh_coordinator.mark_failed(
                (target.cache_key, target.revision)
            )
            sessions.invalidate_target(target.cache_key, expected=target)
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Upstream request failed"},
        )
    return upstream, target


@app.post(
    "/resolve",
    response_model=ResolveResponse,
)
async def resolve(
    payload: ResolveRequest,
    request: Request,
    response: Response,
    sessions: RelaySessionStore = Depends(get_relay_sessions),
    grant_secret: bytes = Depends(get_media_grant_secret),
) -> ResolveResponse:
    requested_media = MediaGrantMedia(
        provider=payload.media.provider,
        id=payload.media.id,
    )
    token = _extract_media_grant(request)
    claims = (
        verify_media_grant(
            token,
            secret=grant_secret,
            expected_media=requested_media,
        )
        if token is not None
        else None
    )
    if claims is None:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "invalid_media_grant",
                "message": "A valid Bearer media grant is required",
            },
            headers={"Cache-Control": "no-store"},
        )

    source_url = _canonical_youtube_url(payload.media.id)
    try:
        result = await run_in_threadpool(resolve_youtube, source_url)
    except MediaResolveError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={
                "code": exc.code,
                "message": exc.public_message,
            },
        ) from exc
    if result.provider != "youtube" or result.media_id != payload.media.id:
        raise HTTPException(
            status_code=422,
            detail={"code": "resolve_failed", "message": "Unable to resolve media"},
        )

    streams = []
    for stream in result.streams:
        session = sessions.create(
            RelayTarget.from_parts(
                stream.upstream_url,
                stream.upstream_headers,
                media_id=result.media_id,
                format_id=stream.format_id,
                source_url=source_url,
            )
        )
        streams.append(
            StreamCapability(
                session=session,
                relay_url=f"/relay/{session}",
                delivery="progressive",
                container="mp4",
                mime_type="video/mp4",
                supports_byte_ranges=True,
                width=stream.width,
                height=stream.height,
                fps=stream.fps,
                bitrate_kbps=stream.bitrate_kbps,
                size_bytes=stream.size_bytes,
                video_codec=stream.video_codec,
                audio_codec=stream.audio_codec,
            )
        )

    response.headers["Cache-Control"] = "private, no-store"
    return ResolveResponse(
        media=MediaIdentity(provider="youtube", id=result.media_id),
        metadata=MediaMetadata(title=result.title, duration=result.duration),
        streams=streams,
    )


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    """Docker/Caddy liveness endpoint without resolver or upstream dependencies."""

    return {"ok": True}


@app.get("/relay/{session}")
async def relay(
    session: str,
    request: Request,
    sessions: RelaySessionStore = Depends(get_relay_sessions),
    relay_http_client: httpx.AsyncClient = Depends(get_relay_http_client),
    refresh_coordinator: RelayRefreshCoordinator = Depends(
        get_relay_refresh_coordinator
    ),
) -> Response:
    target = sessions.get(session)
    if target is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "relay_session_not_found", "message": "Relay session not found"},
        )

    if not is_allowed_upstream_url(target.upstream_url):
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Invalid upstream target"},
        )

    try:
        range_headers = request.headers.getlist("range")
        requested_range = parse_byte_range(
            range_headers[0] if len(range_headers) == 1 else None
        )
    except InvalidByteRange as exc:
        raise HTTPException(
            status_code=416,
            detail={"code": "invalid_range", "message": "A single byte range is required"},
            headers={"Accept-Ranges": "bytes"},
        ) from exc

    upstream, target = await _open_upstream_with_refresh(
        relay_http_client,
        target,
        requested_range,
        sessions,
        refresh_coordinator,
    )

    if upstream.status_code == 416:
        try:
            unsatisfied_headers = validated_unsatisfied_range_headers(upstream)
        except InvalidUpstreamResponse as exc:
            await close_upstream(upstream)
            raise HTTPException(
                status_code=502,
                detail={"code": "relay_failed", "message": "Invalid upstream response"},
            ) from exc
        await close_upstream(upstream)
        return Response(
            status_code=416,
            headers=unsatisfied_headers,
        )

    if upstream.status_code != 206:
        await close_upstream(upstream)
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Upstream did not honor Range"},
        )

    try:
        response_headers = validated_relay_headers(upstream, requested_range)
    except InvalidUpstreamResponse as exc:
        await close_upstream(upstream)
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Invalid upstream response"},
        ) from exc

    return RelayStreamingResponse(upstream, headers=response_headers)


@app.head("/relay/{session}")
async def relay_head(
    session: str,
    sessions: RelaySessionStore = Depends(get_relay_sessions),
    relay_http_client: httpx.AsyncClient = Depends(get_relay_http_client),
    refresh_coordinator: RelayRefreshCoordinator = Depends(
        get_relay_refresh_coordinator
    ),
) -> Response:
    """Return representation metadata using a validated one-byte range probe."""

    target = sessions.get(session)
    if target is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "relay_session_not_found", "message": "Relay session not found"},
        )
    if not is_allowed_upstream_url(target.upstream_url):
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Invalid upstream target"},
        )

    probe_range = ByteRange("bytes=0-0", 0, 0, None)
    upstream, _ = await _open_upstream_with_refresh(
        relay_http_client,
        target,
        probe_range,
        sessions,
        refresh_coordinator,
    )
    if upstream.status_code != 206:
        await close_upstream(upstream)
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Upstream did not honor Range"},
        )

    try:
        response_headers = validated_head_headers(upstream)
    except InvalidUpstreamResponse as exc:
        await close_upstream(upstream)
        raise HTTPException(
            status_code=502,
            detail={"code": "relay_failed", "message": "Invalid upstream response"},
        ) from exc
    await close_upstream(upstream)
    return Response(status_code=200, headers=response_headers)
