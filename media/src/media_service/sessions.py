import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from urllib.parse import urlparse


def is_allowed_upstream_url(url: str) -> bool:
    """Limit relay capabilities to credential-free HTTPS Google media URLs."""

    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    return (
        parsed.scheme.lower() == "https"
        and (hostname == "googlevideo.com" or hostname.endswith(".googlevideo.com"))
        and parsed.username is None
        and parsed.password is None
        and port in {None, 443}
    )


@dataclass(frozen=True, slots=True)
class RelayTarget:
    upstream_url: str
    request_headers: tuple[tuple[str, str], ...] = ()
    media_id: str | None = None
    format_id: str | None = None
    source_url: str | None = None
    # A generation token makes cache invalidation compare-and-delete safe even
    # when yt-dlp happens to return the same URL and headers again (the ABA case).
    revision: str = field(
        default_factory=lambda: secrets.token_urlsafe(16),
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        refresh_values = (self.media_id, self.format_id, self.source_url)
        if any(value is not None for value in refresh_values) and not all(
            isinstance(value, str) and value for value in refresh_values
        ):
            raise ValueError(
                "media_id, format_id, and source_url must be supplied together"
            )

    @property
    def cache_key(self) -> "RelayStreamKey | None":
        if self.media_id is None or self.format_id is None:
            return None
        return RelayStreamKey(self.media_id, self.format_id)

    @classmethod
    def from_parts(
        cls,
        upstream_url: str,
        request_headers: Mapping[str, str],
        *,
        media_id: str | None = None,
        format_id: str | None = None,
        source_url: str | None = None,
    ) -> "RelayTarget":
        return cls(
            upstream_url,
            tuple(request_headers.items()),
            media_id,
            format_id,
            source_url,
        )


@dataclass(frozen=True, slots=True)
class RelayStreamKey:
    """The stable identity of one yt-dlp format across expiring CDN URLs."""

    media_id: str
    format_id: str


@dataclass(frozen=True, slots=True)
class _SessionEntry:
    target: RelayTarget
    expires_at: float


class RelaySessionStore:
    """A bounded, process-local store for sessions and refreshable stream targets."""

    def __init__(
        self,
        *,
        ttl_seconds: float = 900.0,
        max_sessions: int = 2_048,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be greater than zero")
        if max_sessions <= 0:
            raise ValueError("max_sessions must be greater than zero")
        self._ttl_seconds = ttl_seconds
        self._max_sessions = max_sessions
        self._clock = clock
        self._entries: OrderedDict[str, _SessionEntry] = OrderedDict()
        self._targets: dict[RelayStreamKey, RelayTarget] = {}
        self._target_references: dict[RelayStreamKey, int] = {}
        self._lock = threading.Lock()

    def create(self, target: RelayTarget) -> str:
        now = self._clock()
        with self._lock:
            self._purge_expired(now)
            while len(self._entries) >= self._max_sessions:
                oldest_session = next(iter(self._entries))
                self._remove(oldest_session)

            session = secrets.token_urlsafe(32)
            while session in self._entries:
                session = secrets.token_urlsafe(32)
            self._entries[session] = _SessionEntry(
                target=target,
                expires_at=now + self._ttl_seconds,
            )
            if target.cache_key is not None:
                self._targets[target.cache_key] = target
                self._target_references[target.cache_key] = (
                    self._target_references.get(target.cache_key, 0) + 1
                )
                self._update_session_targets(target)
            return session

    def get(self, session: str) -> RelayTarget | None:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(session)
            if entry is None:
                return None
            if entry.expires_at <= now:
                self._remove(session)
                return None
            self._entries[session] = _SessionEntry(
                target=entry.target,
                expires_at=now + self._ttl_seconds,
            )
            self._entries.move_to_end(session)
            if entry.target.cache_key is None:
                return entry.target
            # If a refresh is currently in flight the keyed cache is deliberately
            # empty. The session's last target remains available so this request can
            # join the same refresh path instead of becoming a transient 404.
            return self._targets.get(entry.target.cache_key, entry.target)

    def get_cached_target(self, key: RelayStreamKey) -> RelayTarget | None:
        """Return the current CDN target without extending any session lifetime."""

        with self._lock:
            return self._targets.get(key)

    def invalidate_target(
        self,
        key: RelayStreamKey,
        *,
        expected: RelayTarget,
    ) -> bool:
        """Remove only the failed target, preserving a concurrently refreshed one."""

        with self._lock:
            current = self._targets.get(key)
            if current != expected:
                return False
            del self._targets[key]
            return True

    def compare_and_store_target(
        self,
        target: RelayTarget,
        *,
        expected: RelayTarget | None,
    ) -> RelayTarget | None:
        """Publish a refresh only if the cached generation is still expected.

        The returned target won the compare-and-swap. A newer generation from a
        concurrent resolve therefore wins over a slow refresh. ``None`` means
        no live session still references this stream.
        """

        key = target.cache_key
        if key is None:
            raise ValueError("a cached relay target requires media and format identity")
        if expected is not None and expected.cache_key != key:
            raise ValueError("expected and replacement targets must share a cache key")
        with self._lock:
            current = self._targets.get(key)
            if current != expected:
                return current
            if self._target_references.get(key, 0) <= 0:
                return None
            self._targets[key] = target
            self._update_session_targets(target)
            return target

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._targets.clear()
            self._target_references.clear()

    def _purge_expired(self, now: float) -> None:
        expired = [
            session
            for session, entry in self._entries.items()
            if entry.expires_at <= now
        ]
        for session in expired:
            self._remove(session)

    def _remove(self, session: str) -> None:
        entry = self._entries.pop(session)
        key = entry.target.cache_key
        if key is None:
            return
        remaining_references = self._target_references[key] - 1
        if remaining_references <= 0:
            del self._target_references[key]
            self._targets.pop(key, None)
        else:
            self._target_references[key] = remaining_references

    def _update_session_targets(self, target: RelayTarget) -> None:
        """Point every same-format session at the latest target under the lock."""

        key = target.cache_key
        for session, entry in self._entries.items():
            if entry.target.cache_key == key:
                self._entries[session] = _SessionEntry(
                    target=target,
                    expires_at=entry.expires_at,
                )
