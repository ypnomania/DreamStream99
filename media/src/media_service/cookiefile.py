import os
import secrets
import stat
import tempfile
from collections.abc import Iterator, MutableMapping
from contextlib import contextmanager
from pathlib import Path


DEFAULT_RUNTIME_COOKIEFILE = Path(
    "/tmp/dreamstream-media/youtube.cookies.txt"
)
MAX_COOKIEFILE_BYTES = 16 * 1024 * 1024
_NETSCAPE_COOKIE_HEADERS = {
    b"# HTTP Cookie File",
    b"# Netscape HTTP Cookie File",
}


class CookieFilePreparationError(RuntimeError):
    """The read-only cookie secret could not be staged safely."""


def _copy_cookie_file(
    source: Path,
    destination: Path,
    *,
    maximum_bytes: int = MAX_COOKIEFILE_BYTES,
) -> None:
    """Atomically copy a read-only secret into a private writable file."""

    if not source.is_absolute() or not destination.is_absolute():
        raise CookieFilePreparationError("cookie paths must be absolute")
    if source == destination:
        raise CookieFilePreparationError("cookie source and runtime paths must differ")

    source_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    source_flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        source_fd = os.open(source, source_flags)
    except OSError as exc:
        raise CookieFilePreparationError("cookie source is unavailable") from exc

    temporary_path: Path | None = None
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise CookieFilePreparationError("cookie source must be a regular file")
        if source_stat.st_size <= 0 or source_stat.st_size > maximum_bytes:
            raise CookieFilePreparationError("cookie source has an invalid size")

        parent = destination.parent
        try:
            parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            parent_stat = parent.lstat()
        except OSError as exc:
            raise CookieFilePreparationError(
                "cookie runtime directory is unavailable"
            ) from exc
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != os.geteuid()
        ):
            raise CookieFilePreparationError(
                "cookie runtime directory is not private"
            )
        try:
            parent.chmod(0o700)
            temporary_fd, raw_temporary_path = tempfile.mkstemp(
                prefix=".youtube.cookies.",
                dir=parent,
            )
        except OSError as exc:
            raise CookieFilePreparationError(
                "cookie runtime file cannot be created"
            ) from exc

        temporary_path = Path(raw_temporary_path)
        try:
            os.fchmod(temporary_fd, 0o600)
            copied = 0
            with os.fdopen(source_fd, "rb", closefd=False) as source_file:
                with os.fdopen(temporary_fd, "wb") as destination_file:
                    first_line = source_file.readline(257)
                    if first_line.rstrip(b"\r\n") not in _NETSCAPE_COOKIE_HEADERS:
                        raise CookieFilePreparationError(
                            "cookie source is not in Netscape format"
                        )
                    copied = len(first_line)
                    destination_file.write(first_line)
                    while chunk := source_file.read(64 * 1024):
                        copied += len(chunk)
                        if copied > maximum_bytes:
                            raise CookieFilePreparationError(
                                "cookie source has an invalid size"
                            )
                        destination_file.write(chunk)
                    destination_file.flush()
                    os.fsync(destination_file.fileno())
            os.replace(temporary_path, destination)
            temporary_path = None
            destination.chmod(0o600)
        except (OSError, CookieFilePreparationError) as exc:
            if isinstance(exc, CookieFilePreparationError):
                raise
            raise CookieFilePreparationError(
                "cookie source could not be staged"
            ) from exc
    finally:
        os.close(source_fd)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def prepare_runtime_cookiefile(
    environ: MutableMapping[str, str] | None = None,
    *,
    destination: Path = DEFAULT_RUNTIME_COOKIEFILE,
    maximum_bytes: int = MAX_COOKIEFILE_BYTES,
) -> Path | None:
    """Stage ``YTDLP_COOKIEFILE_SOURCE`` and activate its writable copy."""

    target_environ = os.environ if environ is None else environ
    raw_source = target_environ.get("YTDLP_COOKIEFILE_SOURCE")
    source = raw_source.strip() if raw_source else ""
    if not source:
        return None

    configured_runtime = target_environ.get("YTDLP_COOKIEFILE")
    if configured_runtime and configured_runtime != str(destination):
        raise CookieFilePreparationError(
            "YTDLP_COOKIEFILE must use the managed runtime path"
        )

    _copy_cookie_file(
        Path(source),
        destination,
        maximum_bytes=maximum_bytes,
    )
    target_environ["YTDLP_COOKIEFILE"] = str(destination)
    return destination


@contextmanager
def isolated_runtime_cookiefile(
    source: str | Path,
) -> Iterator[Path]:
    """Give one YoutubeDL instance a unique disposable writable cookie jar."""

    destination = DEFAULT_RUNTIME_COOKIEFILE.parent / (
        f".resolve.{secrets.token_hex(16)}.cookies.txt"
    )
    _copy_cookie_file(Path(source), destination)
    try:
        yield destination
    finally:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
