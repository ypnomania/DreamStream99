import asyncio
import json
import math
import os
import re
import signal
import sys
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from contextlib import suppress
from dataclasses import dataclass
from typing import Generic, TypeVar

from media_service.resolver import (
    MediaResolveError,
    ResolvedMedia,
    ResolvedProgressiveStream,
)
from media_service.sessions import is_allowed_upstream_url


ResolutionKey = TypeVar("ResolutionKey", bound=Hashable)
ResolutionValue = TypeVar("ResolutionValue")


class ResolutionCoordinatorClosedError(RuntimeError):
    """The process-local resolution coordinator is shutting down."""


class ResolutionTimeoutError(TimeoutError):
    """A shared resolution flight exceeded its complete time budget."""


class ResolutionCapacityError(RuntimeError):
    """The bounded resolution admission queue is full."""


class ResolutionExecutor:
    """Run each yt-dlp extraction in a bounded, terminable process group."""

    def __init__(
        self,
        *,
        max_workers: int = 1,
        command: tuple[str, ...] | None = None,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be greater than zero")
        selected_command = command or (
            sys.executable,
            "-m",
            "media_service.resolution_worker",
        )
        if not selected_command or any(
            not isinstance(part, str) or not part for part in selected_command
        ):
            raise ValueError("command must contain non-empty strings")
        self._capacity = asyncio.Semaphore(max_workers)
        self._command = selected_command
        self._processes: set[asyncio.subprocess.Process] = set()
        self._active_tasks: set[asyncio.Task[object]] = set()
        self._state_lock = asyncio.Lock()
        self._closed = False

    async def resolve(self, source_url: str) -> ResolvedMedia:
        if not isinstance(source_url, str) or not source_url:
            raise TypeError("source_url must be a non-empty string")
        current = asyncio.current_task()
        if current is None:
            raise RuntimeError("resolution requires an asyncio task")
        async with self._state_lock:
            if self._closed:
                raise ResolutionCoordinatorClosedError(
                    "the resolution executor is closed"
                )
            self._active_tasks.add(current)

        acquired = False
        process: asyncio.subprocess.Process | None = None
        try:
            await self._capacity.acquire()
            acquired = True
            async with self._state_lock:
                if self._closed:
                    raise ResolutionCoordinatorClosedError(
                        "the resolution executor is closed"
                    )

            spawn = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    *self._command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=_worker_environment(),
                    start_new_session=True,
                ),
                name="media-resolver-spawn",
            )
            try:
                process = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                process, _ = await _await_task_uninterruptibly(spawn)
                async with self._state_lock:
                    self._processes.add(process)
                await _terminate_process_uninterruptibly(process)
                raise

            async with self._state_lock:
                self._processes.add(process)
                closed_after_spawn = self._closed
            if closed_after_spawn:
                raise ResolutionCoordinatorClosedError(
                    "the resolution executor is closed"
                )

            request = json.dumps(
                {"url": source_url},
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8")
            output = await _exchange_with_worker(process, request)
            if process.returncode != 0:
                raise _worker_failure()
            return _decode_worker_output(output, source_url=source_url)
        except asyncio.CancelledError:
            if process is not None:
                await _terminate_process_uninterruptibly(process)
            raise
        except MediaResolveError:
            if process is not None and process.returncode is None:
                cancelled = await _terminate_process_uninterruptibly(process)
                if cancelled:
                    raise asyncio.CancelledError
            raise
        except Exception as exc:
            if process is not None and process.returncode is None:
                cancelled = await _terminate_process_uninterruptibly(process)
                if cancelled:
                    raise asyncio.CancelledError from exc
            raise _worker_failure() from exc
        finally:
            async with self._state_lock:
                if process is not None and process.returncode is not None:
                    self._processes.discard(process)
                self._active_tasks.discard(current)
            if acquired:
                self._capacity.release()

    async def aclose(self) -> None:
        """Reject new work, cancel active calls, and reap every process group."""

        current = asyncio.current_task()
        async with self._state_lock:
            self._closed = True
            active_tasks = tuple(
                task for task in self._active_tasks if task is not current
            )
            processes = tuple(self._processes)

        for task in active_tasks:
            task.cancel()
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
        if processes:
            await asyncio.gather(
                *(
                    _terminate_process_uninterruptibly(process)
                    for process in processes
                ),
                return_exceptions=True,
            )
        async with self._state_lock:
            self._processes = {
                process for process in self._processes
                if process.returncode is None
            }


_MAX_WORKER_OUTPUT_BYTES = 2 * 1024 * 1024
_WORKER_READ_CHUNK_BYTES = 64 * 1024
_YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}")
_SAFE_WORKER_ERRORS = {
    "resolve_failed": ("Unable to resolve media", 422),
    "youtube_auth_required": (
        "YouTube authentication is required for this media",
        502,
    ),
}
_WORKER_ENVIRONMENT_KEYS = (
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "YTDLP_COOKIEFILE",
    "YTDLP_PLAYER_CLIENT",
    "YTDLP_PO_TOKEN_PROVIDER",
    "YTDLP_PROXY",
    "YTDLP_SOCKET_TIMEOUT",
    "MEDIA_EGRESS_PROXY",
)


def _worker_environment() -> dict[str, str]:
    return {
        name: os.environ[name]
        for name in _WORKER_ENVIRONMENT_KEYS
        if name in os.environ
    }


async def _exchange_with_worker(
    process: asyncio.subprocess.Process,
    request: bytes,
) -> bytes:
    if process.stdin is None or process.stdout is None:
        raise _worker_failure()
    process.stdin.write(request)
    await process.stdin.drain()
    process.stdin.close()
    with suppress(BrokenPipeError, ConnectionResetError):
        await process.stdin.wait_closed()

    output = bytearray()
    while True:
        remaining = _MAX_WORKER_OUTPUT_BYTES + 1 - len(output)
        if remaining <= 0:
            raise _worker_failure()
        chunk = await process.stdout.read(
            min(_WORKER_READ_CHUNK_BYTES, remaining)
        )
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > _MAX_WORKER_OUTPUT_BYTES:
            raise _worker_failure()
    await process.wait()
    return bytes(output)


async def _await_task_uninterruptibly(
    task: asyncio.Task[ResolutionValue],
) -> tuple[ResolutionValue, bool]:
    cancelled = False
    while True:
        try:
            return await asyncio.shield(task), cancelled
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancelled = True


async def _terminate_process_uninterruptibly(
    process: asyncio.subprocess.Process,
) -> bool:
    cleanup = asyncio.create_task(
        _terminate_process(process),
        name="media-resolver-reap",
    )
    _, cancelled = await _await_task_uninterruptibly(cleanup)
    return cancelled


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    _signal_process_group(process.pid, signal.SIGTERM)
    if process.returncode is None:
        with suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(process.wait()), timeout=2.0)
    if _process_group_exists(process.pid):
        _signal_process_group(process.pid, signal.SIGKILL)
    if process.returncode is None:
        with suppress(ProcessLookupError, ChildProcessError):
            await process.wait()


def _signal_process_group(process_group: int, selected_signal: signal.Signals) -> None:
    with suppress(ProcessLookupError, PermissionError):
        os.killpg(process_group, selected_signal)


def _process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _decode_worker_output(output: bytes, *, source_url: str) -> ResolvedMedia:
    if not output or len(output) > _MAX_WORKER_OUTPUT_BYTES:
        raise _worker_failure()
    try:
        envelope = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _worker_failure() from exc
    if not isinstance(envelope, dict) or set(envelope) not in (
        {"ok", "error"},
        {"ok", "result"},
    ):
        raise _worker_failure()
    if envelope.get("ok") is False:
        error = envelope.get("error")
        if not isinstance(error, dict) or set(error) != {
            "code",
            "public_message",
            "status_code",
        }:
            raise _worker_failure()
        code = error.get("code")
        safe_error = _SAFE_WORKER_ERRORS.get(code)
        if safe_error is None:
            raise _worker_failure()
        public_message, status_code = safe_error
        raise MediaResolveError(
            "the resolver worker rejected the media",
            code=code,
            public_message=public_message,
            status_code=status_code,
        )
    result = envelope.get("result")
    if (
        envelope.get("ok") is not True
        or not isinstance(result, dict)
        or set(result) != {"provider", "media_id", "title", "duration", "streams"}
    ):
        raise _worker_failure()
    expected_media_id = source_url.rsplit("=", 1)[-1]
    if (
        result["provider"] != "youtube"
        or result["media_id"] != expected_media_id
        or _YOUTUBE_ID.fullmatch(expected_media_id) is None
        or not _bounded_text(result["title"], maximum=512)
        or not _optional_number(result["duration"], maximum=31_536_000)
        or not isinstance(result["streams"], list)
        or len(result["streams"]) > 64
    ):
        raise _worker_failure()
    streams = tuple(_decode_stream(stream) for stream in result["streams"])
    return ResolvedMedia(
        provider="youtube",
        media_id=expected_media_id,
        title=result["title"],
        duration=result["duration"],
        streams=streams,
    )


def _decode_stream(stream: object) -> ResolvedProgressiveStream:
    expected_keys = {
        "upstream_url",
        "upstream_headers",
        "format_id",
        "width",
        "height",
        "fps",
        "bitrate_kbps",
        "size_bytes",
        "video_codec",
        "audio_codec",
    }
    if not isinstance(stream, dict) or set(stream) != expected_keys:
        raise _worker_failure()
    upstream_url = stream["upstream_url"]
    headers = stream["upstream_headers"]
    if (
        not isinstance(upstream_url, str)
        or len(upstream_url) > 16_384
        or not is_allowed_upstream_url(upstream_url)
        or not isinstance(headers, dict)
        or len(headers) > 32
        or not _bounded_text(stream["format_id"], maximum=128)
        or not _optional_integer(stream["width"], maximum=16_384)
        or not _optional_integer(stream["height"], maximum=16_384)
        or not _optional_number(stream["fps"], maximum=1_000)
        or not _optional_number(stream["bitrate_kbps"], maximum=1_000_000_000)
        or not _optional_integer(stream["size_bytes"], maximum=10**15)
        or not _bounded_text(stream["video_codec"], maximum=128)
        or not _bounded_text(stream["audio_codec"], maximum=128)
    ):
        raise _worker_failure()
    validated_headers: dict[str, str] = {}
    total_header_bytes = 0
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or _HEADER_NAME.fullmatch(name) is None
            or not isinstance(value, str)
            or not value
            or len(value) > 8_192
            or "\r" in value
            or "\n" in value
        ):
            raise _worker_failure()
        total_header_bytes += len(name) + len(value)
        if total_header_bytes > 65_536:
            raise _worker_failure()
        validated_headers[name] = value
    return ResolvedProgressiveStream(
        upstream_url=upstream_url,
        upstream_headers=validated_headers,
        format_id=stream["format_id"],
        width=stream["width"],
        height=stream["height"],
        fps=stream["fps"],
        bitrate_kbps=stream["bitrate_kbps"],
        size_bytes=stream["size_bytes"],
        video_codec=stream["video_codec"],
        audio_codec=stream["audio_codec"],
    )


def _bounded_text(value: object, *, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= maximum
        and "\x00" not in value
    )


def _optional_number(value: object, *, maximum: float) -> bool:
    return value is None or (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and 0 <= value <= maximum
    )


def _optional_integer(value: object, *, maximum: int) -> bool:
    return value is None or (
        not isinstance(value, bool)
        and isinstance(value, int)
        and 0 <= value <= maximum
    )


def _worker_failure() -> MediaResolveError:
    return MediaResolveError(
        "the media resolver worker failed",
        code="resolve_unavailable",
        public_message="Media resolver is temporarily unavailable",
        status_code=502,
    )


@dataclass(frozen=True, slots=True)
class _CacheEntry(Generic[ResolutionValue]):
    value: ResolutionValue
    expires_at: float


class ResolutionCoordinator(Generic[ResolutionKey, ResolutionValue]):
    """Bound and deduplicate expensive process-local media resolutions.

    One task is shared by every caller for the same key, including callers that
    bypass a cached value with ``force=True``. Flights for different keys pass
    through one global semaphore so libraries with process-global state are not
    invoked concurrently unless the configured limit explicitly permits it.

    Waiting callers shield the shared task from their own cancellation. The
    coordinator still owns the task and cancels it during :meth:`aclose`.
    Successful values are retained in a short-lived, least-recently-used cache;
    exceptions and timeouts are never cached.
    """

    def __init__(
        self,
        *,
        cache_ttl_seconds: float = 180.0,
        max_cache_entries: int = 64,
        max_concurrent_resolutions: int = 1,
        max_pending_resolutions: int = 8,
        timeout_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if cache_ttl_seconds <= 0:
            raise ValueError("cache_ttl_seconds must be greater than zero")
        if max_cache_entries <= 0:
            raise ValueError("max_cache_entries must be greater than zero")
        if max_concurrent_resolutions <= 0:
            raise ValueError("max_concurrent_resolutions must be greater than zero")
        if max_pending_resolutions < max_concurrent_resolutions:
            raise ValueError(
                "max_pending_resolutions must be at least max_concurrent_resolutions"
            )
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")

        self._cache_ttl_seconds = cache_ttl_seconds
        self._max_cache_entries = max_cache_entries
        self._max_pending_resolutions = max_pending_resolutions
        self._timeout_seconds = timeout_seconds
        self._clock = clock
        self._guard = asyncio.Lock()
        self._capacity = asyncio.Semaphore(max_concurrent_resolutions)
        self._cache: OrderedDict[
            ResolutionKey,
            _CacheEntry[ResolutionValue],
        ] = OrderedDict()
        self._flights: dict[
            ResolutionKey,
            asyncio.Task[ResolutionValue],
        ] = {}
        self._closed = False

    async def run(
        self,
        key: ResolutionKey,
        operation: Callable[[], Awaitable[ResolutionValue]],
        *,
        force: bool = False,
    ) -> ResolutionValue:
        """Return a cached value or join/start the one flight for ``key``.

        ``force`` bypasses a completed cache entry, but it never creates a
        duplicate flight when another resolution for the same key is active.
        """

        if not callable(operation):
            raise TypeError("operation must be callable")

        async with self._guard:
            if self._closed:
                raise ResolutionCoordinatorClosedError(
                    "the resolution coordinator is closed"
                )

            now = self._clock()
            self._purge_expired(now)
            flight = self._flights.get(key)
            if flight is None and not force:
                cached = self._cache.get(key)
                if cached is not None:
                    self._cache.move_to_end(key)
                    return cached.value

            if flight is None:
                if len(self._flights) >= self._max_pending_resolutions:
                    raise ResolutionCapacityError(
                        "the media resolution queue is full"
                    )
                flight = asyncio.create_task(
                    self._run_flight(key, operation),
                    name="media-resolution",
                )
                flight.add_done_callback(self._consume_flight_result)
                self._flights[key] = flight

        try:
            return await asyncio.shield(flight)
        except asyncio.CancelledError:
            if self._closed:
                raise ResolutionCoordinatorClosedError(
                    "the resolution coordinator is closed"
                ) from None
            raise

    async def invalidate(self, key: ResolutionKey) -> bool:
        """Forget one completed cached value without disturbing an active flight."""

        async with self._guard:
            return self._cache.pop(key, None) is not None

    async def clear_cache(self) -> None:
        """Forget every completed value without cancelling active resolutions."""

        async with self._guard:
            self._cache.clear()

    async def aclose(self) -> None:
        """Reject new work, cancel owned flights, and discard cached targets."""

        async with self._guard:
            self._closed = True
            flights = tuple(self._flights.values())
            self._cache.clear()

        for flight in flights:
            flight.cancel()
        if flights:
            await asyncio.gather(*flights, return_exceptions=True)

        async with self._guard:
            self._flights.clear()

    async def __aenter__(self) -> "ResolutionCoordinator[ResolutionKey, ResolutionValue]":
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
        await self.aclose()

    async def _run_flight(
        self,
        key: ResolutionKey,
        operation: Callable[[], Awaitable[ResolutionValue]],
    ) -> ResolutionValue:
        current = asyncio.current_task()
        try:
            try:
                async with asyncio.timeout(self._timeout_seconds):
                    async with self._capacity:
                        value = await operation()
            except TimeoutError as exc:
                raise ResolutionTimeoutError(
                    "media resolution exceeded its time limit"
                ) from exc

            async with self._guard:
                if not self._closed:
                    self._store_cached(key, value, self._clock())
            return value
        finally:
            async with self._guard:
                if self._flights.get(key) is current:
                    del self._flights[key]

    def _store_cached(
        self,
        key: ResolutionKey,
        value: ResolutionValue,
        now: float,
    ) -> None:
        self._cache[key] = _CacheEntry(
            value=value,
            expires_at=now + self._cache_ttl_seconds,
        )
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_cache_entries:
            self._cache.popitem(last=False)

    def _purge_expired(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._cache.items()
            if entry.expires_at <= now
        ]
        for key in expired:
            del self._cache[key]

    @staticmethod
    def _consume_flight_result(flight: asyncio.Task[ResolutionValue]) -> None:
        # A disconnected caller can leave a shared flight without any waiters.
        # Retrieving its result prevents a spurious "exception was never retrieved"
        # warning while preserving the same result for remaining shielded waiters.
        with suppress(asyncio.CancelledError, Exception):
            flight.exception()
