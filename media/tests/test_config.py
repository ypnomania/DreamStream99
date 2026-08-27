import os
import subprocess
import sys

import pytest
from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS

from media_service.config import (
    ALLOWED_YOUTUBE_PLAYER_CLIENTS,
    CONCRETE_YOUTUBE_PLAYER_CLIENTS,
    ConfigurationError,
    DEFAULT_YOUTUBE_PLAYER_CLIENT,
    MediaEgressProxySettings,
    MediaGrantSettings,
    MediaOriginSettings,
    RelayRefreshSettings,
    SafeYtDlpLogger,
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
        "youtube": {"player_client": ["default"]},
        "youtubepot-wpc": {
            "browser_path": ["/Applications/Browser"],
            "timeout": ["30"],
        },
    }
    assert options["js_runtimes"] == {"node": {}}


def test_yt_dlp_logger_discards_sensitive_extractor_output(capsys):
    logger = SafeYtDlpLogger()
    sensitive = (
        "ERROR: [youtube] private-video-id "
        "https://googlevideo.example/path?token=do-not-log"
    )

    logger.debug(sensitive)
    logger.info(sensitive)
    logger.warning(sensitive)
    logger.error(sensitive)

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_yt_dlp_options_always_install_the_safe_logger():
    options = YtDlpSettings.from_env({}).youtube_dl_options()

    assert isinstance(options["logger"], SafeYtDlpLogger)


def test_authenticated_media_egress_proxy_is_forwarded_to_yt_dlp_exactly():
    proxy = "https://relay-user:dummy-password@proxy.example:8443"

    options = YtDlpSettings.from_env(
        {"MEDIA_EGRESS_PROXY": proxy}
    ).youtube_dl_options()

    assert options["proxy"] == proxy


def test_yt_dlp_explicitly_disables_ambient_proxy_when_unconfigured():
    options = YtDlpSettings.from_env({}).youtube_dl_options()

    assert options["proxy"] == ""


def test_legacy_ytdlp_proxy_uses_the_same_validated_egress_setting():
    proxy = "http://legacy-user:dummy-password@proxy.example:8080"

    assert MediaEgressProxySettings.from_env(
        {"YTDLP_PROXY": proxy}
    ).proxy == proxy


@pytest.mark.parametrize(
    "proxy",
    [
        "socks5://proxy.example:1080",
        "http://",
        "http://proxy.example/private-path",
        "http://proxy.example?credential=secret",
        "http://proxy.example#secret",
        "http://proxy.example:99999",
        " http://proxy.example:8080",
    ],
)
def test_invalid_media_egress_proxy_is_rejected_without_echoing_value(proxy):
    with pytest.raises(ConfigurationError) as captured:
        MediaEgressProxySettings.from_env({"MEDIA_EGRESS_PROXY": proxy})

    assert proxy not in str(captured.value)


def test_conflicting_proxy_aliases_fail_without_leaking_credentials():
    with pytest.raises(ConfigurationError) as captured:
        MediaEgressProxySettings.from_env(
            {
                "MEDIA_EGRESS_PROXY": "http://user:first-secret@one.example:8080",
                "YTDLP_PROXY": "http://user:second-secret@two.example:8080",
            }
        )

    assert "first-secret" not in str(captured.value)
    assert "second-secret" not in str(captured.value)


@pytest.mark.parametrize(
    "client",
    ["default", "mweb", "tv", "tv_downgraded", "web", "web_embedded"],
)
def test_youtube_player_client_has_a_strict_allowlist(client):
    options = YtDlpSettings.from_env(
        {"YTDLP_PLAYER_CLIENT": client}
    ).youtube_dl_options()

    assert options["extractor_args"]["youtube"] == {
        "player_client": [client]
    }


@pytest.mark.parametrize(
    "client",
    ["WEB", "android", "tv_embedded", "mweb,web", " mweb ", "../../client"],
)
def test_invalid_youtube_player_client_is_rejected(client):
    with pytest.raises(ConfigurationError):
        YtDlpSettings.from_env({"YTDLP_PLAYER_CLIENT": client})


def test_allowlisted_clients_exist_and_support_cookies_in_pinned_yt_dlp():
    assert DEFAULT_YOUTUBE_PLAYER_CLIENT == "default"
    assert DEFAULT_YOUTUBE_PLAYER_CLIENT not in INNERTUBE_CLIENTS
    assert ALLOWED_YOUTUBE_PLAYER_CLIENTS == {
        DEFAULT_YOUTUBE_PLAYER_CLIENT,
        *CONCRETE_YOUTUBE_PLAYER_CLIENTS,
    }
    assert CONCRETE_YOUTUBE_PLAYER_CLIENTS <= INNERTUBE_CLIENTS.keys()
    assert all(
        INNERTUBE_CLIENTS[client].get("SUPPORTS_COOKIES") is True
        for client in CONCRETE_YOUTUBE_PLAYER_CLIENTS
    )


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
