import asyncio
import re
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import TypeVar

import anyio
import httpx
from starlette.responses import StreamingResponse

from media_service.sessions import RelayStreamKey, RelayTarget


_RefreshResult = TypeVar("_RefreshResult")
RelayRefreshKey = tuple[RelayStreamKey, str]


class InvalidByteRange(ValueError):
    """The client supplied a byte range outside the relay PoC contract."""


class InvalidUpstreamResponse(ValueError):
    """The upstream did not honor the requested byte range safely."""


class RelayRefreshCooldownError(RuntimeError):
    """A failed relay generation is still inside its retry cooldown."""


@dataclass(frozen=True, slots=True)
class ByteRange:
    raw: str
    start: int | None
    end: int | None
    suffix_length: int | None


_BYTE_RANGE = re.compile(r"bytes=(?:(\d+)-(\d*)|-(\d+))", re.IGNORECASE)
_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)", re.IGNORECASE)
_UNSATISFIED_CONTENT_RANGE = re.compile(r"bytes \*/(\d+)", re.IGNORECASE)
_REQUEST_HEADER_DENYLIST = frozenset(
    {
        "accept-encoding",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "range",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
_RELAY_RESPONSE_HEADERS = {
    "Content-Range": "content-range",
    "Content-Length": "content-length",
    "Content-Type": "content-type",
    "Accept-Ranges": "accept-ranges",
}


class RelayRefreshCoordinator:
    """Share one refresh task between concurrent requests for the same stream.

    The shared task is shielded from individual client cancellation. This keeps
    a browser that abandons one Range request from cancelling the yt-dlp refresh
    needed by the other Range requests for the same media format.
    """

    def __init__(
        self,
        *,
        max_concurrent_refreshes: int = 4,
        timeout_seconds: float = 30.0,
        failure_cooldown_seconds: float = 5.0,
    ) -> None:
        if max_concurrent_refreshes <= 0:
            raise ValueError("max_concurrent_refreshes must be greater than zero")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        if failure_cooldown_seconds <= 0:
            raise ValueError("failure_cooldown_seconds must be greater than zero")
        self._guard = asyncio.Lock()
        self._capacity = asyncio.Semaphore(max_concurrent_refreshes)
        self._timeout_seconds = timeout_seconds
        self._failure_cooldown_seconds = failure_cooldown_seconds
        self._flights: dict[RelayRefreshKey, asyncio.Task[object]] = {}
        self._retry_after: dict[RelayRefreshKey, float] = {}
        self._closed = False

    async def run(
        self,
        key: RelayRefreshKey,
        operation: Callable[[], Awaitable[_RefreshResult]],
    ) -> _RefreshResult:
        async with self._guard:
            if self._closed:
                raise RuntimeError("the relay refresh coordinator is closed")
            now = asyncio.get_running_loop().time()
            self._retry_after = {
                failed_key: deadline
                for failed_key, deadline in self._retry_after.items()
                if deadline > now
            }
            if key in self._retry_after:
                raise RelayRefreshCooldownError(
                    "the failed relay generation is cooling down"
                )
            flight = self._flights.get(key)
            if flight is None:
                flight = asyncio.create_task(
                    self._run_flight(key, operation),
                    name=(
                        f"relay-refresh:{key[0].media_id}:{key[0].format_id}:"
                        f"{key[1][:8]}"
                    ),
                )
                flight.add_done_callback(self._consume_flight_result)
                self._flights[key] = flight

        # asyncio.shield prevents one disconnected client from cancelling the
        # task that all other requests for this key are awaiting.
        return await asyncio.shield(flight)  # type: ignore[return-value]

    async def aclose(self) -> None:
        async with self._guard:
            self._closed = True
            flights = tuple(self._flights.values())
        for flight in flights:
            flight.cancel()
        if flights:
            await asyncio.gather(*flights, return_exceptions=True)

    async def mark_failed(self, key: RelayRefreshKey) -> None:
        """Cool down a generation whose refreshed origin URL also failed.

        A successful yt-dlp operation normally removes its flight without a
        cooldown. If the replacement URL immediately returns 403, however, the
        generation is still known-bad and must not start another expensive
        resolve on the next browser Range request.
        """

        async with self._guard:
            if self._closed:
                return
            self._retry_after[key] = (
                asyncio.get_running_loop().time()
                + self._failure_cooldown_seconds
            )

    async def _run_flight(
        self,
        key: RelayRefreshKey,
        operation: Callable[[], Awaitable[_RefreshResult]],
    ) -> _RefreshResult:
        current = asyncio.current_task()
        failed = False
        try:
            async with self._capacity:
                async with asyncio.timeout(self._timeout_seconds):
                    return await operation()
        except Exception:
            failed = True
            raise
        finally:
            async with self._guard:
                if self._flights.get(key) is current:
                    del self._flights[key]
                if failed:
                    self._retry_after[key] = (
                        asyncio.get_running_loop().time()
                        + self._failure_cooldown_seconds
                    )

    @staticmethod
    def _consume_flight_result(flight: asyncio.Task[object]) -> None:
        # A disconnected request may have been the only waiter. Retrieving the
        # terminal exception prevents an otherwise spurious "never retrieved"
        # event-loop warning; later/remaining awaiters still receive it normally.
        with suppress(asyncio.CancelledError, Exception):
            flight.exception()


async def close_upstream(upstream: httpx.Response) -> None:
    """Close one upstream response without masking the primary request outcome."""

    with anyio.CancelScope(shield=True), suppress(Exception):
        await upstream.aclose()


def parse_byte_range(value: str | None) -> ByteRange:
    if value is None:
        raise InvalidByteRange("a Range header is required")
    match = _BYTE_RANGE.fullmatch(value.strip())
    if match is None:
        # Multiple ranges would require multipart/byteranges, which is out of scope.
        raise InvalidByteRange("only one bytes range is supported")

    start_text, end_text, suffix_text = match.groups()
    try:
        suffix_length = int(suffix_text) if suffix_text is not None else None
        start = int(start_text) if start_text is not None else None
        end = int(end_text) if end_text else None
    except ValueError as exc:
        raise InvalidByteRange("the byte range number is too large") from exc

    if suffix_length is not None:
        if suffix_length <= 0:
            raise InvalidByteRange("a suffix range must be greater than zero")
        return ByteRange(value, None, None, suffix_length)

    assert start is not None
    if end is not None and start > end:
        raise InvalidByteRange("the byte range start exceeds its end")
    return ByteRange(value, start, end, None)


def upstream_request_headers(
    target: RelayTarget,
    requested_range: ByteRange,
) -> dict[str, str]:
    headers = {
        name: value
        for name, value in target.request_headers
        if name.lower() not in _REQUEST_HEADER_DENYLIST
    }
    # identity + aiter_raw() preserves the exact byte offsets and Content-Length.
    headers["Accept-Encoding"] = "identity"
    headers["Range"] = requested_range.raw
    return headers


def validated_relay_headers(
    upstream: httpx.Response,
    requested_range: ByteRange,
) -> dict[str, str]:
    try:
        relay_headers = {
            public_name: upstream.headers[upstream_name]
            for public_name, upstream_name in _RELAY_RESPONSE_HEADERS.items()
        }
    except KeyError as exc:
        raise InvalidUpstreamResponse("a required range header is missing") from exc

    content_range_match = _CONTENT_RANGE.fullmatch(
        relay_headers["Content-Range"].strip()
    )
    if content_range_match is None:
        raise InvalidUpstreamResponse("Content-Range is invalid")

    try:
        range_start, range_end, complete_length = map(
            int,
            content_range_match.groups(),
        )
        content_length = int(relay_headers["Content-Length"])
    except ValueError as exc:
        raise InvalidUpstreamResponse("Content-Length is invalid") from exc

    if (
        complete_length <= 0
        or range_start > range_end
        or range_end >= complete_length
        or content_length != range_end - range_start + 1
        or relay_headers["Accept-Ranges"].strip().lower() != "bytes"
        or relay_headers["Content-Type"].split(";", 1)[0].strip().lower()
        != "video/mp4"
    ):
        raise InvalidUpstreamResponse("the upstream range metadata is inconsistent")

    content_encoding = upstream.headers.get("content-encoding")
    if content_encoding and content_encoding.strip().lower() != "identity":
        raise InvalidUpstreamResponse("encoded upstream byte ranges are not supported")

    if requested_range.suffix_length is not None:
        expected_length = min(requested_range.suffix_length, complete_length)
        if (
            range_start != complete_length - expected_length
            or range_end != complete_length - 1
        ):
            raise InvalidUpstreamResponse("the upstream returned a different suffix range")
    else:
        expected_end = min(
            requested_range.end
            if requested_range.end is not None
            else complete_length - 1,
            complete_length - 1,
        )
        if range_start != requested_range.start or range_end != expected_end:
            raise InvalidUpstreamResponse("the upstream returned a different byte range")

    return relay_headers


def validated_head_headers(upstream: httpx.Response) -> dict[str, str]:
    """Build safe representation headers from a ``bytes=0-0`` GET probe.

    Google media origins do not expose consistent ``HEAD`` behavior. A one-byte
    range probe preserves the relay's strict validation while revealing the
    complete representation length without reading or buffering media bytes.
    """

    probe_range = ByteRange("bytes=0-0", 0, 0, None)
    relay_headers = validated_relay_headers(upstream, probe_range)
    match = _CONTENT_RANGE.fullmatch(relay_headers["Content-Range"].strip())
    if match is None:  # Defensive: validated_relay_headers already checked it.
        raise InvalidUpstreamResponse("Content-Range is invalid")
    return {
        "Content-Length": match.group(3),
        "Content-Type": relay_headers["Content-Type"],
        "Accept-Ranges": relay_headers["Accept-Ranges"],
    }


def validated_unsatisfied_range_headers(upstream: httpx.Response) -> dict[str, str]:
    content_range = upstream.headers.get("content-range")
    accept_ranges = upstream.headers.get("accept-ranges")
    match = (
        _UNSATISFIED_CONTENT_RANGE.fullmatch(content_range.strip())
        if content_range
        else None
    )
    try:
        complete_length = int(match.group(1)) if match else -1
    except ValueError as exc:
        raise InvalidUpstreamResponse("the upstream 416 range is invalid") from exc
    if (
        match is None
        or complete_length < 0
        or accept_ranges is None
        or accept_ranges.strip().lower() != "bytes"
    ):
        raise InvalidUpstreamResponse("the upstream 416 range is invalid")
    return {
        "Content-Range": content_range,
        "Accept-Ranges": accept_ranges,
    }


class RelayStreamingResponse(StreamingResponse):
    """A streaming response that always cancels its one upstream response."""

    def __init__(
        self,
        upstream: httpx.Response,
        *,
        headers: dict[str, str],
    ) -> None:
        self._upstream = upstream
        super().__init__(
            upstream.aiter_raw(),
            status_code=206,
            headers=headers,
        )

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Starlette cancellation and ASGI send failures both end up here.
            # Shielding makes sure the active upstream socket is released promptly.
            await close_upstream(self._upstream)
