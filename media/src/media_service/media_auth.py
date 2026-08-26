"""Strict verifier for DreamStream99's cross-language ``mg1`` media grant."""

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Any


MEDIA_GRANT_VERSION = 1
MEDIA_GRANT_TYPE = "media-grant"
MEDIA_GRANT_ISSUER = "dreamstream99-control"
MEDIA_GRANT_AUDIENCE = "dreamstream99-media"
MEDIA_GRANT_TOKEN_PREFIX = "mg1"
MEDIA_GRANT_SIGNING_DOMAIN = b"DreamStream99.MediaGrant.HMAC-SHA256.v1\0"
MAX_MEDIA_GRANT_TTL_SECONDS = 120
MAX_MEDIA_GRANT_TOKEN_LENGTH = 2_048
MAX_EPOCH_SECONDS = 8_640_000_000_000

_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")
_ROOM_ID = re.compile(r"[A-HJ-NP-Z2-9]{8}")
_YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
_CLAIM_KEYS = {
    "v",
    "type",
    "iss",
    "aud",
    "roomId",
    "subject",
    "role",
    "media",
    "jti",
    "iat",
    "exp",
}


@dataclass(frozen=True, slots=True)
class MediaGrantMedia:
    provider: str
    id: str


@dataclass(frozen=True, slots=True)
class MediaGrantClaims:
    v: int
    type: str
    iss: str
    aud: str
    room_id: str
    subject: str
    role: str
    media: MediaGrantMedia
    jti: str
    iat: int
    exp: int


def verify_media_grant(
    token: str,
    *,
    secret: bytes,
    expected_media: MediaGrantMedia,
    now_seconds: int | None = None,
) -> MediaGrantClaims | None:
    """Authenticate and strictly parse a canonical media grant.

    Every malformed, tampered, expired, future-issued, over-TTL, or
    media-mismatched input collapses to ``None`` without exposing verifier
    details to the caller.
    """

    try:
        if (
            not isinstance(token, str)
            or not token
            or len(token) > MAX_MEDIA_GRANT_TOKEN_LENGTH
            or not isinstance(secret, bytes)
            or not 32 <= len(secret) <= 4_096
        ):
            return None
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != MEDIA_GRANT_TOKEN_PREFIX:
            return None
        payload_text, signature_text = parts[1], parts[2]
        payload_bytes = _decode_base64url(payload_text)
        signature = _decode_base64url(signature_text)
        if len(signature) != hashlib.sha256().digest_size:
            return None

        message = MEDIA_GRANT_SIGNING_DOMAIN + f"mg1.{payload_text}".encode()
        expected_signature = hmac.digest(secret, message, "sha256")
        if not hmac.compare_digest(signature, expected_signature):
            return None

        parsed = json.loads(
            payload_bytes.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {value}")
            ),
        )
        claims = _parse_claims(parsed)
        if claims is None:
            return None
        canonical_payload = _encode_base64url(_canonical_claims_json(claims))
        if not hmac.compare_digest(canonical_payload, payload_text):
            return None

        now = int(time.time()) if now_seconds is None else now_seconds
        if type(now) is not int or not 0 <= now <= MAX_EPOCH_SECONDS:
            return None
        if claims.iat > now or claims.exp <= now:
            return None
        if claims.exp - claims.iat > MAX_MEDIA_GRANT_TTL_SECONDS:
            return None
        if claims.media != expected_media:
            return None
        return claims
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        return None


def _parse_claims(value: Any) -> MediaGrantClaims | None:
    if not isinstance(value, dict) or set(value) != _CLAIM_KEYS:
        return None
    if (
        value["v"] != MEDIA_GRANT_VERSION
        or type(value["v"]) is not int
        or value["type"] != MEDIA_GRANT_TYPE
        or value["iss"] != MEDIA_GRANT_ISSUER
        or value["aud"] != MEDIA_GRANT_AUDIENCE
    ):
        return None
    room_id = value["roomId"]
    role = value["role"]
    subject = value["subject"]
    jti = value["jti"]
    media = value["media"]
    iat = value["iat"]
    exp = value["exp"]
    if not isinstance(room_id, str) or _ROOM_ID.fullmatch(room_id) is None:
        return None
    if role not in {"owner", "guest"}:
        return None
    if not isinstance(subject, str):
        return None
    if role == "owner":
        if subject != "host":
            return None
    elif _UUID.fullmatch(subject) is None:
        return None
    if not isinstance(jti, str) or _UUID.fullmatch(jti) is None:
        return None
    if (
        not isinstance(media, dict)
        or set(media) != {"provider", "id"}
        or media.get("provider") != "youtube"
        or not isinstance(media.get("id"), str)
        or _YOUTUBE_ID.fullmatch(media["id"]) is None
    ):
        return None
    if (
        type(iat) is not int
        or type(exp) is not int
        or not 0 <= iat <= MAX_EPOCH_SECONDS
        or not 0 <= exp <= MAX_EPOCH_SECONDS
        or exp <= iat
        or exp - iat > MAX_MEDIA_GRANT_TTL_SECONDS
    ):
        return None
    return MediaGrantClaims(
        v=MEDIA_GRANT_VERSION,
        type=MEDIA_GRANT_TYPE,
        iss=MEDIA_GRANT_ISSUER,
        aud=MEDIA_GRANT_AUDIENCE,
        room_id=room_id,
        subject=subject,
        role=role,
        media=MediaGrantMedia(provider="youtube", id=media["id"]),
        jti=jti,
        iat=iat,
        exp=exp,
    )


def _canonical_claims_json(claims: MediaGrantClaims) -> bytes:
    ordered = {
        "v": claims.v,
        "type": claims.type,
        "iss": claims.iss,
        "aud": claims.aud,
        "roomId": claims.room_id,
        "subject": claims.subject,
        "role": claims.role,
        "media": {
            "provider": claims.media.provider,
            "id": claims.media.id,
        },
        "jti": claims.jti,
        "iat": claims.iat,
        "exp": claims.exp,
    }
    return json.dumps(
        ordered,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _decode_base64url(value: str) -> bytes:
    if _BASE64URL.fullmatch(value) is None or len(value) % 4 == 1:
        raise ValueError("invalid base64url")
    padding = "=" * ((4 - len(value) % 4) % 4)
    decoded = base64.b64decode(
        (value + padding).encode("ascii"),
        altchars=b"-_",
        validate=True,
    )
    if _encode_base64url(decoded) != value:
        raise ValueError("non-canonical base64url")
    return decoded


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
