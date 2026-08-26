import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from time import perf_counter

import pytest
from fastapi.testclient import TestClient

from media_service.main import MEDIA_ALLOWED_ORIGIN, app


pytestmark = pytest.mark.integration
SECRET = "youtube-integration-media-grant-secret-v1"


@dataclass(frozen=True)
class YouTubeCase:
    name: str
    media_id: str
    expected_status: int


CASES = [
    YouTubeCase("regular", os.getenv("YOUTUBE_REGULAR_TEST_ID", "jNQXAC9IVRw"), 200),
    YouTubeCase("age_restricted", os.getenv("YOUTUBE_AGE_RESTRICTED_TEST_ID", "RBPk185Hd0A"), 200),
    YouTubeCase("nonexistent", "AAAAAAAAAAA", 422),
    YouTubeCase("dash_hd", os.getenv("YOUTUBE_DASH_TEST_ID", "aqz-KE-bpKQ"), 200),
]


def _grant(media_id: str) -> str:
    issued_at = int(time.time())
    claims = {
        "v": 1, "type": "media-grant", "iss": "dreamstream99-control",
        "aud": "dreamstream99-media", "roomId": "ABCD2345",
        "subject": "11111111-1111-4111-8111-111111111111", "role": "guest",
        "media": {"provider": "youtube", "id": media_id},
        "jti": "22222222-2222-4222-8222-222222222222",
        "iat": issued_at, "exp": issued_at + 120,
    }
    payload = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    signature = hmac.digest(
        SECRET.encode(),
        b"DreamStream99.MediaGrant.HMAC-SHA256.v1\0" + f"mg1.{payload}".encode(),
        hashlib.sha256,
    )
    return f"mg1.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


@pytest.mark.skipif(
    os.getenv("RUN_YOUTUBE_INTEGRATION") != "1",
    reason="set RUN_YOUTUBE_INTEGRATION=1 to contact YouTube",
)
@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_real_youtube_resolution(case: YouTubeCase, record_property, monkeypatch):
    budget = float(os.getenv("YOUTUBE_RESOLVE_BUDGET_SECONDS", "60"))
    monkeypatch.setenv("MEDIA_GRANT_SECRET", SECRET)
    with TestClient(app, headers={"Origin": MEDIA_ALLOWED_ORIGIN}) as client:
        started = perf_counter()
        response = client.post(
            "/resolve",
            json={"media": {"provider": "youtube", "id": case.media_id}},
            headers={"Authorization": f"Bearer {_grant(case.media_id)}"},
        )
        elapsed = perf_counter() - started
        record_property("case", case.name)
        record_property("elapsed_seconds", round(elapsed, 3))
        assert elapsed <= budget
        assert response.status_code == case.expected_status, response.text
        if case.expected_status != 200:
            assert response.json()["detail"]["code"] == "resolve_failed"
            return
        body = response.json()
        assert body["media"] == {"provider": "youtube", "id": case.media_id}
        assert body["metadata"]["title"] and body["streams"]
        assert "googlevideo" not in response.text
        relay = client.get(
            body["streams"][0]["relay_url"], headers={"Range": "bytes=0-1023"}
        )
        assert relay.status_code == 206, relay.text
        assert relay.headers["Content-Range"]
