from collections.abc import Mapping
from contextlib import nullcontext
from dataclasses import dataclass
from math import isfinite
from typing import Any
from urllib.parse import urlparse

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from media_service.config import ConfigurationError, YtDlpSettings
from media_service.cookiefile import (
    CookieFilePreparationError,
    isolated_runtime_cookiefile,
)
from media_service.sessions import is_allowed_upstream_url


class MediaResolveError(Exception):
    """An expected resolver failure with a safe public representation."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "resolve_failed",
        public_message: str = "Unable to resolve media",
        status_code: int = 422,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = public_message
        self.status_code = status_code


_YOUTUBE_AUTH_REQUIRED_MARKERS = (
    "sign in to confirm you’re not a bot",
    "sign in to confirm you're not a bot",
    "login required",
    "requires authentication",
    "this video is only available for registered users",
    "use --cookies-from-browser or --cookies",
)


def _download_error_requires_youtube_authentication(exc: DownloadError) -> bool:
    """Classify known yt-dlp auth challenges without exposing their text."""

    messages: list[str] = []
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen and len(messages) < 4:
        seen.add(id(current))
        messages.append(str(current).casefold())
        current = current.__cause__ or current.__context__
    combined = "\n".join(messages)
    return any(marker in combined for marker in _YOUTUBE_AUTH_REQUIRED_MARKERS)


@dataclass(frozen=True, slots=True)
class ResolvedProgressiveStream:
    upstream_url: str
    upstream_headers: Mapping[str, str]
    format_id: str
    width: int | None
    height: int | None
    fps: float | None
    bitrate_kbps: float | None
    size_bytes: int | None
    video_codec: str
    audio_codec: str


@dataclass(frozen=True, slots=True)
class ResolvedMedia:
    provider: str
    media_id: str
    title: str
    duration: float | None
    streams: tuple[ResolvedProgressiveStream, ...]


def _yt_dlp_options() -> dict[str, Any]:
    """Build per-resolution options from the service configuration abstraction."""

    return YtDlpSettings.from_env().youtube_dl_options()


def _codec_is_present(codec: Any) -> bool:
    return isinstance(codec, str) and codec.lower() not in {"", "none"}


def _protocol(format_info: Mapping[str, Any]) -> str:
    protocol = format_info.get("protocol")
    if isinstance(protocol, str) and protocol:
        return protocol.lower()

    url = format_info.get("url")
    if isinstance(url, str):
        return urlparse(url).scheme.lower()
    return "unknown"


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed >= 0 else None


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if isfinite(parsed) and parsed >= 0 else None


def _request_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(name): str(header_value)
        for name, header_value in value.items()
        if isinstance(name, str)
        and name
        and isinstance(header_value, str)
        and header_value
    }


def _normalize_format(
    format_info: Mapping[str, Any],
    common_headers: Mapping[str, str],
    cookie_header: str | None,
) -> ResolvedProgressiveStream | None:
    url = format_info.get("url")
    format_id = format_info.get("format_id")
    video_codec = format_info.get("vcodec")
    audio_codec = format_info.get("acodec")
    if (
        not isinstance(url, str)
        or not url
        or not isinstance(format_id, str)
        or not format_id
    ):
        return None
    if not _codec_is_present(video_codec) or not _codec_is_present(audio_codec):
        # Exclude every adaptive audio-only or video-only track.
        return None

    if (
        str(format_info.get("ext") or "").lower() != "mp4"
        or _protocol(format_info) not in {"http", "https"}
        or not is_allowed_upstream_url(url)
        or format_info.get("manifest_url")
    ):
        # The relay is intentionally limited to a directly-addressable muxed MP4.
        return None

    headers = dict(common_headers)
    headers.update(_request_headers(format_info.get("http_headers")))
    if cookie_header:
        # YoutubeDL scopes this value to the concrete media URL. It stays internal.
        headers["Cookie"] = cookie_header
    return ResolvedProgressiveStream(
        upstream_url=url,
        upstream_headers=headers,
        format_id=format_id,
        width=_optional_int(format_info.get("width")),
        height=_optional_int(format_info.get("height")),
        fps=_optional_float(format_info.get("fps")),
        bitrate_kbps=_optional_float(format_info.get("tbr")),
        size_bytes=_optional_int(format_info.get("filesize")),
        video_codec=str(video_codec),
        audio_codec=str(audio_codec),
    )


def resolve_youtube(url: str) -> ResolvedMedia:
    cookie_headers: dict[str, str] = {}
    try:
        options = _yt_dlp_options()
        configured_cookiefile = options.get("cookiefile")
        cookie_context = (
            isolated_runtime_cookiefile(configured_cookiefile)
            if isinstance(configured_cookiefile, str) and configured_cookiefile
            else nullcontext(None)
        )
        with cookie_context as request_cookiefile:
            if request_cookiefile is not None:
                options["cookiefile"] = str(request_cookiefile)
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=False)
                if isinstance(info, Mapping):
                    for raw_format in info.get("formats") or []:
                        if not isinstance(raw_format, Mapping):
                            continue
                        upstream_url = raw_format.get("url")
                        if (
                            not isinstance(upstream_url, str)
                            or not is_allowed_upstream_url(upstream_url)
                        ):
                            continue
                        cookie_header = ydl.cookiejar.get_cookie_header(upstream_url)
                        if isinstance(cookie_header, str) and cookie_header:
                            cookie_headers[upstream_url] = cookie_header
    except (ConfigurationError, CookieFilePreparationError) as exc:
        raise MediaResolveError("invalid media resolver configuration") from exc
    except DownloadError as exc:
        if _download_error_requires_youtube_authentication(exc):
            raise MediaResolveError(
                "yt-dlp reported a YouTube authentication challenge",
                code="youtube_auth_required",
                public_message="YouTube authentication is required for this media",
                status_code=502,
            ) from exc
        raise MediaResolveError("yt-dlp could not resolve this media") from exc
    except (OSError, ValueError) as exc:
        raise MediaResolveError("the media resolver failed") from exc

    if not isinstance(info, Mapping):
        raise MediaResolveError("yt-dlp returned no video metadata")

    video_id = info.get("id")
    title = info.get("title")
    if not video_id or not title:
        raise MediaResolveError("yt-dlp returned incomplete video metadata")

    common_headers = _request_headers(info.get("http_headers"))
    streams = []
    for raw_format in info.get("formats") or []:
        if not isinstance(raw_format, Mapping):
            continue
        raw_url = raw_format.get("url")
        cookie_header = (
            cookie_headers.get(raw_url) if isinstance(raw_url, str) else None
        )
        normalized = _normalize_format(raw_format, common_headers, cookie_header)
        if normalized is not None:
            streams.append(normalized)
    streams.sort(
        key=lambda item: (
            -(item.height or 0),
            item.format_id,
        )
    )

    return ResolvedMedia(
        provider="youtube",
        media_id=str(video_id),
        title=str(title),
        duration=_optional_float(info.get("duration")),
        streams=tuple(streams),
    )
