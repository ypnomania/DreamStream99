import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from ipaddress import ip_address
from math import isfinite
from typing import Any
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Raised when service configuration cannot be converted safely."""


_PROVIDER_NAMESPACE = re.compile(r"youtubepot-[a-z0-9][a-z0-9_-]*", re.IGNORECASE)
_EXTRACTOR_ARGUMENT = re.compile(r"[a-z0-9][a-z0-9_-]*", re.IGNORECASE)
_DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
DEFAULT_ALLOWED_ORIGIN = "https://ypnomania.github.io"
DEFAULT_YOUTUBE_PLAYER_CLIENT = "default"
CONCRETE_YOUTUBE_PLAYER_CLIENTS = frozenset(
    {"mweb", "tv", "tv_downgraded", "web", "web_embedded"}
)
ALLOWED_YOUTUBE_PLAYER_CLIENTS = frozenset(
    {DEFAULT_YOUTUBE_PLAYER_CLIENT, *CONCRETE_YOUTUBE_PLAYER_CLIENTS}
)


class SafeYtDlpLogger:
    """Discard extractor text that may contain IDs, URLs, or cookie details.

    yt-dlp still raises ``DownloadError`` with the original in-memory message,
    allowing the resolver to produce a fixed public error classification.
    """

    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


SAFE_YTDLP_LOGGER = SafeYtDlpLogger()


def _optional_env(environ: Mapping[str, str], name: str) -> str | None:
    value = environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _required_secret(
    environ: Mapping[str, str],
    name: str,
    *,
    minimum_length: int = 32,
    maximum_length: int = 4_096,
) -> str:
    # Secrets are protocol bytes, not human-entered configuration. In
    # particular, do not strip whitespace here: the Node issuer signs the exact
    # UTF-8 value and the Python verifier must import the same bytes.
    value = environ.get(name)
    byte_length = (
        len(value.encode("utf-8")) if isinstance(value, str) else 0
    )
    if not minimum_length <= byte_length <= maximum_length:
        raise ConfigurationError(
            f"{name} must contain {minimum_length}-{maximum_length} UTF-8 bytes"
        )
    assert isinstance(value, str)
    return value


def _exact_https_origin(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 2_048
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        raise ConfigurationError("ALLOWED_ORIGIN must be one exact HTTPS origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ConfigurationError("ALLOWED_ORIGIN must be one exact HTTPS origin") from exc
    hostname = parsed.hostname
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.netloc != parsed.netloc.lower()
        or hostname.endswith(".")
        or port == 443
    ):
        raise ConfigurationError("ALLOWED_ORIGIN must be one exact HTTPS origin")
    try:
        address = ip_address(hostname)
    except ValueError:
        if any(_DNS_LABEL.fullmatch(label) is None for label in hostname.split(".")):
            raise ConfigurationError("ALLOWED_ORIGIN has an invalid hostname")
        canonical_host = hostname
    else:
        canonical_host = str(address)
        if address.version == 6:
            canonical_host = f"[{canonical_host}]"
    canonical_netloc = canonical_host + (f":{port}" if port is not None else "")
    if parsed.netloc != canonical_netloc or value != f"https://{canonical_netloc}":
        raise ConfigurationError("ALLOWED_ORIGIN must be one exact HTTPS origin")
    return value


def _positive_float(environ: Mapping[str, str], name: str, default: float) -> float:
    raw_value = _optional_env(environ, name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if not isfinite(value) or value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _positive_int(environ: Mapping[str, str], name: str, default: int) -> int:
    raw_value = _optional_env(environ, name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _validated_http_proxy(value: str) -> str:
    error = "media egress proxy must be one valid HTTP(S) proxy URL"
    if (
        not value
        or len(value) > 2_048
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        raise ConfigurationError(error)
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError as exc:
        raise ConfigurationError(error) from exc
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username == ""
        or (parsed.password is not None and parsed.username is None)
    ):
        raise ConfigurationError(error)
    return value


@dataclass(frozen=True, slots=True)
class MediaEgressProxySettings:
    proxy: str | None = None

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "MediaEgressProxySettings":
        source = os.environ if environ is None else environ
        preferred = source.get("MEDIA_EGRESS_PROXY") or None
        legacy = source.get("YTDLP_PROXY") or None
        if preferred is not None and legacy is not None and preferred != legacy:
            raise ConfigurationError(
                "MEDIA_EGRESS_PROXY and YTDLP_PROXY must match when both are set"
            )
        selected = preferred or legacy
        return cls(proxy=_validated_http_proxy(selected) if selected else None)


def _provider_extractor_args(spec: str) -> dict[str, dict[str, list[str]]]:
    """Parse yt-dlp's documented ``KEY:ARGS`` syntax for a POT provider.

    The provider namespace is deliberately generic. Deployments choose which
    ``youtubepot-*`` plugin is installed and pass only its extractor arguments.
    """

    namespace, separator, raw_arguments = spec.partition(":")
    if not _PROVIDER_NAMESPACE.fullmatch(namespace):
        raise ConfigurationError(
            "YTDLP_PO_TOKEN_PROVIDER must use a youtubepot-* extractor namespace"
        )

    parsed_arguments: dict[str, list[str]] = {}
    if separator:
        if not raw_arguments:
            raise ConfigurationError(
                "YTDLP_PO_TOKEN_PROVIDER has an empty extractor argument list"
            )
        for assignment in raw_arguments.split(";"):
            name, equals, raw_values = assignment.partition("=")
            name = name.strip().replace("-", "_")
            if (
                not equals
                or not _EXTRACTOR_ARGUMENT.fullmatch(name)
                or not raw_values
            ):
                raise ConfigurationError(
                    "YTDLP_PO_TOKEN_PROVIDER contains an invalid extractor argument"
                )
            values = [value.strip() for value in raw_values.split(",")]
            if any(not value for value in values):
                raise ConfigurationError(
                    "YTDLP_PO_TOKEN_PROVIDER contains an empty extractor value"
                )
            parsed_arguments[name] = values

    return {namespace.lower(): parsed_arguments}


@dataclass(frozen=True, slots=True)
class YtDlpSettings:
    cookiefile: str | None = None
    po_token_provider: str | None = None
    player_client: str = DEFAULT_YOUTUBE_PLAYER_CLIENT
    proxy: str | None = None
    socket_timeout: float = 20.0

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "YtDlpSettings":
        source = os.environ if environ is None else environ
        raw_player_client = source.get("YTDLP_PLAYER_CLIENT")
        player_client = (
            DEFAULT_YOUTUBE_PLAYER_CLIENT
            if raw_player_client in {None, ""}
            else raw_player_client
        )
        if player_client not in ALLOWED_YOUTUBE_PLAYER_CLIENTS:
            raise ConfigurationError(
                "YTDLP_PLAYER_CLIENT is not an allowed YouTube client"
            )
        return cls(
            cookiefile=_optional_env(source, "YTDLP_COOKIEFILE"),
            po_token_provider=_optional_env(source, "YTDLP_PO_TOKEN_PROVIDER"),
            player_client=player_client,
            proxy=MediaEgressProxySettings.from_env(source).proxy,
            socket_timeout=_positive_float(source, "YTDLP_SOCKET_TIMEOUT", 20.0),
        )

    def youtube_dl_options(self) -> dict[str, Any]:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "logger": SAFE_YTDLP_LOGGER,
            "skip_download": True,
            "noplaylist": True,
            "extract_flat": False,
            "socket_timeout": self.socket_timeout,
            "js_runtimes": {"node": {}},
        }

        if self.cookiefile:
            options["cookiefile"] = self.cookiefile
        # An empty value is yt-dlp's documented direct-connection sentinel;
        # this prevents ambient HTTP_PROXY variables from splitting egress.
        options["proxy"] = self.proxy or ""
        extractor_args: dict[str, dict[str, list[str]]] = {
            "youtube": {"player_client": [self.player_client]},
        }
        if self.po_token_provider:
            extractor_args.update(_provider_extractor_args(self.po_token_provider))
        options["extractor_args"] = extractor_args

        return options


@dataclass(frozen=True, slots=True)
class RelayRefreshSettings:
    timeout_seconds: float = 30.0
    failure_cooldown_seconds: float = 5.0
    max_concurrent_refreshes: int = 4

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "RelayRefreshSettings":
        source = os.environ if environ is None else environ
        return cls(
            timeout_seconds=_positive_float(
                source,
                "RELAY_REFRESH_TIMEOUT_SECONDS",
                30.0,
            ),
            failure_cooldown_seconds=_positive_float(
                source,
                "RELAY_REFRESH_FAILURE_COOLDOWN_SECONDS",
                5.0,
            ),
            max_concurrent_refreshes=_positive_int(
                source,
                "RELAY_MAX_CONCURRENT_REFRESHES",
                4,
            ),
        )


@dataclass(frozen=True, slots=True)
class MediaGrantSettings:
    secret: str

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "MediaGrantSettings":
        source = os.environ if environ is None else environ
        return cls(secret=_required_secret(source, "MEDIA_GRANT_SECRET"))


@dataclass(frozen=True, slots=True)
class MediaOriginSettings:
    allowed_origin: str = DEFAULT_ALLOWED_ORIGIN

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "MediaOriginSettings":
        source = os.environ if environ is None else environ
        return cls(
            allowed_origin=_exact_https_origin(
                source.get("ALLOWED_ORIGIN", DEFAULT_ALLOWED_ORIGIN)
            )
        )
