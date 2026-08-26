import os
import subprocess
import sys

import pytest

from media_service.config import (
    ConfigurationError,
    MediaGrantSettings,
    MediaOriginSettings,
    RelayRefreshSettings,
    YtDlpSettings,
)


def test_provider_config_uses_plugin_namespace_without_hardcoding_provider():
    options = YtDlpSettings.from_env(
        {
            "YTDLP_PO_TOKEN_PROVIDER": (
                "youtubepot-wpc:browser_path=/Applications/Browser;timeout=30"
            ),
        }
    ).youtube_dl_options()

    assert options["extractor_args"] == {
        "youtube": {"player_client": ["web"]},
        "youtubepot-wpc": {
            "browser_path": ["/Applications/Browser"],
            "timeout": ["30"],
        },
    }
    assert options["js_runtimes"] == {"node": {}}


@pytest.mark.parametrize(
    "value",
    [
        "youtube:po_token=static-token",
        "bgutil:http",
        "youtubepot-bgutilhttp:",
        "youtubepot-bgutilhttp:base_url=",
        "youtubepot-bgutilhttp:base_url=http://pot:4416,",
    ],
)
def test_invalid_provider_config_is_rejected(value):
    settings = YtDlpSettings.from_env({"YTDLP_PO_TOKEN_PROVIDER": value})
    with pytest.raises(ConfigurationError):
        settings.youtube_dl_options()


@pytest.mark.parametrize("value", ["zero", "0", "-1", "nan", "inf"])
def test_invalid_socket_timeout_is_rejected(value):
    with pytest.raises(ConfigurationError):
        YtDlpSettings.from_env({"YTDLP_SOCKET_TIMEOUT": value})


def test_refresh_limits_are_configurable_and_strictly_positive():
    settings = RelayRefreshSettings.from_env(
        {
            "RELAY_REFRESH_TIMEOUT_SECONDS": "12.5",
            "RELAY_REFRESH_FAILURE_COOLDOWN_SECONDS": "3",
            "RELAY_MAX_CONCURRENT_REFRESHES": "2",
        }
    )

    assert settings == RelayRefreshSettings(
        timeout_seconds=12.5,
        failure_cooldown_seconds=3.0,
        max_concurrent_refreshes=2,
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("RELAY_REFRESH_TIMEOUT_SECONDS", "0"),
        ("RELAY_REFRESH_FAILURE_COOLDOWN_SECONDS", "nan"),
        ("RELAY_MAX_CONCURRENT_REFRESHES", "1.5"),
        ("RELAY_MAX_CONCURRENT_REFRESHES", "-1"),
    ],
)
def test_invalid_refresh_limits_are_rejected(name, value):
    with pytest.raises(ConfigurationError):
        RelayRefreshSettings.from_env({name: value})


def test_media_grant_secret_is_required_and_not_normalized():
    secret = "  媒体授权-shared-secret-" + ("x" * 32) + "  "

    assert MediaGrantSettings.from_env(
        {"MEDIA_GRANT_SECRET": secret}
    ).secret == secret


@pytest.mark.parametrize(
    "value",
    [None, "", "short-secret", "x" * 4097],
)
def test_missing_or_short_media_grant_secret_is_rejected(value):
    environ = {} if value is None else {"MEDIA_GRANT_SECRET": value}
    with pytest.raises(ConfigurationError):
        MediaGrantSettings.from_env(environ)


def test_media_origin_defaults_to_production_and_accepts_one_exact_override():
    assert MediaOriginSettings.from_env({}).allowed_origin == (
        "https://ypnomania.github.io"
    )
    assert MediaOriginSettings.from_env(
        {"ALLOWED_ORIGIN": "https://watch.example.com:8443"}
    ).allowed_origin == "https://watch.example.com:8443"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "*",
        "https://one.example,https://two.example",
        "http://watch.example.com",
        "https://watch.example.com/",
        "https://watch.example.com/path",
        "https://watch.example.com?query=1",
        "https://watch.example.com#fragment",
        "https://user@watch.example.com",
        "https://WATCH.example.com",
        "https://watch.example.com:443",
        "https://watch.example.com:08443",
        " https://watch.example.com",
        "https://bad_host.example.com",
    ],
)
def test_media_origin_rejects_noncanonical_or_unsafe_values(value):
    with pytest.raises(ConfigurationError):
        MediaOriginSettings.from_env({"ALLOWED_ORIGIN": value})


def test_media_app_imports_the_exact_origin_override():
    environ = {
        **os.environ,
        "ALLOWED_ORIGIN": "https://watch.example.com:8443",
    }
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from media_service.main import MEDIA_ALLOWED_ORIGIN; "
                "print(MEDIA_ALLOWED_ORIGIN)"
            ),
        ],
        check=True,
        capture_output=True,
        text=True,
        env=environ,
    )
    assert result.stdout.strip() == "https://watch.example.com:8443"
