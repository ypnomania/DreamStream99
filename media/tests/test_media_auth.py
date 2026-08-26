import json
from dataclasses import asdict
from pathlib import Path

from media_service.media_auth import MediaGrantMedia, verify_media_grant


VECTOR_PATH = Path(__file__).resolve().parents[2] / "tests/fixtures/media-grant-v1.json"


def _vector() -> dict:
    return json.loads(VECTOR_PATH.read_text(encoding="utf-8"))


def test_node_fixed_vector_verifies_to_the_exact_python_claims():
    vector = _vector()
    expected_media = MediaGrantMedia(**vector["input"]["media"])
    claims = verify_media_grant(
        vector["token"],
        secret=vector["secretUtf8"].encode(),
        expected_media=expected_media,
        now_seconds=vector["input"]["nowMs"] // 1_000,
    )
    assert claims is not None
    assert asdict(claims) == {
        "v": 1, "type": "media-grant", "iss": "dreamstream99-control",
        "aud": "dreamstream99-media", "room_id": vector["claims"]["roomId"],
        "subject": vector["claims"]["subject"], "role": vector["claims"]["role"],
        "media": vector["claims"]["media"], "jti": vector["claims"]["jti"],
        "iat": vector["claims"]["iat"], "exp": vector["claims"]["exp"],
    }


def test_fixed_vector_rejects_tampering_time_boundaries_and_media_reuse():
    vector = _vector()
    secret = vector["secretUtf8"].encode()
    media = MediaGrantMedia(**vector["input"]["media"])
    prefix, payload, signature = vector["token"].split(".")
    mutated = signature[:-1] + ("A" if signature[-1] != "A" else "B")
    cases = [
        (f"{prefix}.{payload}.{mutated}", media, vector["claims"]["iat"]),
        (vector["token"], media, vector["claims"]["exp"]),
        (vector["token"], media, vector["claims"]["iat"] - 1),
        (vector["token"], MediaGrantMedia("youtube", "M7lc1UVf-VE"), vector["claims"]["iat"]),
    ]
    for token, expected_media, now in cases:
        assert verify_media_grant(
            token, secret=secret, expected_media=expected_media, now_seconds=now
        ) is None
