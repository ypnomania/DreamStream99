import os
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from media_service.cookiefile import (
    CookieFilePreparationError,
    isolated_runtime_cookiefile,
    prepare_runtime_cookiefile,
)
from media_service.main import app


def _cookie_source(path: Path, content: bytes = b"# Netscape HTTP Cookie File\n") -> Path:
    path.write_bytes(content)
    path.chmod(0o400)
    return path


def test_read_only_cookie_secret_is_staged_as_private_writable_copy(tmp_path):
    source = _cookie_source(tmp_path / "youtube.cookies.secret")
    destination = tmp_path / "runtime" / "youtube.cookies.txt"
    environ = {"YTDLP_COOKIEFILE_SOURCE": str(source)}

    activated = prepare_runtime_cookiefile(
        environ,
        destination=destination,
    )

    assert activated == destination
    assert environ["YTDLP_COOKIEFILE"] == str(destination)
    assert destination.read_bytes() == source.read_bytes()
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert stat.S_IMODE(destination.parent.stat().st_mode) == 0o700

    # yt-dlp may update its cookie jar on close; only the private copy changes.
    destination.write_bytes(destination.read_bytes() + b"# runtime update\n")
    assert source.read_bytes() == b"# Netscape HTTP Cookie File\n"


def test_cookie_staging_replaces_an_old_runtime_copy_atomically(tmp_path):
    source = _cookie_source(
        tmp_path / "youtube.cookies.secret",
        b"# Netscape HTTP Cookie File\nnew-session\n",
    )
    destination = tmp_path / "runtime" / "youtube.cookies.txt"
    destination.parent.mkdir()
    destination.write_text("old-session", encoding="utf-8")

    prepare_runtime_cookiefile(
        {"YTDLP_COOKIEFILE_SOURCE": str(source)},
        destination=destination,
    )

    assert destination.read_bytes() == source.read_bytes()
    assert list(destination.parent.glob(".youtube.cookies.*")) == []


@pytest.mark.parametrize("content", [b"", b"12345"])
def test_invalid_cookie_secret_size_fails_without_activating_path(
    tmp_path,
    content,
):
    source = _cookie_source(tmp_path / "private-cookie-name", content)
    environ = {"YTDLP_COOKIEFILE_SOURCE": str(source)}

    with pytest.raises(CookieFilePreparationError) as captured:
        prepare_runtime_cookiefile(
            environ,
            destination=tmp_path / "runtime" / "youtube.cookies.txt",
            maximum_bytes=4,
        )

    assert "YTDLP_COOKIEFILE" not in environ
    assert "private-cookie-name" not in str(captured.value)


def test_cookie_source_symlink_is_rejected(tmp_path):
    real_source = _cookie_source(tmp_path / "real.cookies")
    symlink = tmp_path / "linked.cookies"
    symlink.symlink_to(real_source)

    with pytest.raises(CookieFilePreparationError):
        prepare_runtime_cookiefile(
            {"YTDLP_COOKIEFILE_SOURCE": str(symlink)},
            destination=tmp_path / "runtime" / "youtube.cookies.txt",
        )


def test_cookie_source_requires_a_netscape_header(tmp_path):
    source = _cookie_source(tmp_path / "invalid.cookies", b"name=value\n")

    with pytest.raises(
        CookieFilePreparationError,
        match="not in Netscape format",
    ):
        prepare_runtime_cookiefile(
            {"YTDLP_COOKIEFILE_SOURCE": str(source)},
            destination=tmp_path / "runtime" / "youtube.cookies.txt",
        )


@pytest.mark.parametrize(
    "header",
    [b"# Netscape HTTP Cookie File\n", b"# HTTP Cookie File\r\n"],
)
def test_cookie_source_accepts_both_standard_headers(tmp_path, header):
    source = _cookie_source(tmp_path / "source.cookies", header + b"row\n")
    destination = tmp_path / "runtime" / "youtube.cookies.txt"

    prepare_runtime_cookiefile(
        {"YTDLP_COOKIEFILE_SOURCE": str(source)},
        destination=destination,
    )

    assert destination.read_bytes() == header + b"row\n"


def test_concurrent_resolvers_get_unique_disposable_cookiefiles(tmp_path):
    source_content = b"# Netscape HTTP Cookie File\nbase-session\n"
    source = _cookie_source(tmp_path / "runtime-base.cookies", source_content)
    barrier = Barrier(4)

    def use_cookie_copy(index: int) -> Path:
        with isolated_runtime_cookiefile(source) as request_cookiefile:
            barrier.wait(timeout=5)
            with request_cookiefile.open("ab") as handle:
                handle.write(f"request-{index}\n".encode("ascii"))
            barrier.wait(timeout=5)
            assert request_cookiefile.read_bytes().startswith(source_content)
            return request_cookiefile

    with ThreadPoolExecutor(max_workers=4) as executor:
        request_paths = list(executor.map(use_cookie_copy, range(4)))

    assert len(set(request_paths)) == 4
    assert all(not path.exists() for path in request_paths)
    assert source.read_bytes() == source_content


def test_absent_source_preserves_direct_writable_cookiefile_configuration():
    environ = {"YTDLP_COOKIEFILE": "/tmp/existing.cookies.txt"}

    assert prepare_runtime_cookiefile(environ) is None
    assert environ == {"YTDLP_COOKIEFILE": "/tmp/existing.cookies.txt"}


def test_cookie_source_rejects_a_conflicting_runtime_path(tmp_path):
    source = _cookie_source(tmp_path / "source.cookies")
    environ = {
        "YTDLP_COOKIEFILE_SOURCE": str(source),
        "YTDLP_COOKIEFILE": "/run/secrets/source.cookies",
    }

    with pytest.raises(
        CookieFilePreparationError,
        match="must use the managed runtime path",
    ):
        prepare_runtime_cookiefile(
            environ,
            destination=tmp_path / "runtime" / "youtube.cookies.txt",
        )


def test_cookie_source_accepts_the_exact_managed_runtime_path(tmp_path):
    source = _cookie_source(tmp_path / "source.cookies")
    destination = tmp_path / "runtime" / "youtube.cookies.txt"
    environ = {
        "YTDLP_COOKIEFILE_SOURCE": str(source),
        "YTDLP_COOKIEFILE": str(destination),
    }

    activated = prepare_runtime_cookiefile(
        environ,
        destination=destination,
    )

    assert activated == destination
    assert environ["YTDLP_COOKIEFILE"] == str(destination)


def test_fastapi_lifespan_stages_cookie_before_becoming_healthy():
    secret = "media-cookie-lifespan-test-secret-32-bytes"
    with (
        patch("media_service.main.prepare_runtime_cookiefile") as prepare,
        patch.dict(os.environ, {"MEDIA_GRANT_SECRET": secret}),
        TestClient(app) as client,
    ):
        assert client.get("/healthz").status_code == 200

    prepare.assert_called_once_with()


def test_fastapi_startup_fails_closed_when_cookie_staging_fails():
    secret = "media-cookie-lifespan-test-secret-32-bytes"
    with (
        patch(
            "media_service.main.prepare_runtime_cookiefile",
            side_effect=CookieFilePreparationError("safe internal error"),
        ),
        patch.dict(os.environ, {"MEDIA_GRANT_SECRET": secret}),
        pytest.raises(RuntimeError, match="media service initialization failed"),
        TestClient(app),
    ):
        pass


def test_fastapi_startup_fails_closed_for_an_invalid_player_client():
    secret = "media-cookie-lifespan-test-secret-32-bytes"
    with (
        patch.dict(
            os.environ,
            {
                "MEDIA_GRANT_SECRET": secret,
                "YTDLP_PLAYER_CLIENT": "untrusted-client",
            },
        ),
        patch("media_service.main.prepare_runtime_cookiefile") as prepare,
        pytest.raises(RuntimeError, match="media service initialization failed"),
        TestClient(app),
    ):
        pass

    prepare.assert_not_called()
