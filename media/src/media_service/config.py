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
    proxy: str | None = None
    socket_timeout: float = 20.0

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "YtDlpSettings":
        source = os.environ if environ is None else environ
        return cls(
            cookiefile=_optional_env(source, "YTDLP_COOKIEFILE"),
            po_token_provider=_optional_env(source, "YTDLP_PO_TOKEN_PROVIDER"),
            proxy=_optional_env(source, "YTDLP_PROXY"),
            socket_timeout=_positive_float(source, "YTDLP_SOCKET_TIMEOUT", 20.0),
        )

    def youtube_dl_options(self) -> dict[str, Any]:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "extract_flat": False,
            "socket_timeout": self.socket_timeout,
            "js_runtimes": {"node": {}},
        }

        if self.cookiefile:
            options["cookiefile"] = self.cookiefile
        if self.proxy:
            options["proxy"] = self.proxy
        if self.po_token_provider:
            extractor_args: dict[str, dict[str, list[str]]] = {
                "youtube": {"player_client": ["web"]},
            }
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
