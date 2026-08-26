from typing import Literal
from pydantic import BaseModel, ConfigDict, field_validator


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResolveMedia(_StrictModel):
    provider: Literal["youtube"]
    id: str

    @field_validator("id")
    @classmethod
    def validate_youtube_id(cls, value: str) -> str:
        if len(value) != 11 or any(
            not (character.isascii() and (character.isalnum() or character in "_-"))
            for character in value
        ):
            raise ValueError("id must be an 11-character YouTube video ID")
        return value


class ResolveRequest(_StrictModel):
    media: ResolveMedia


class MediaIdentity(_StrictModel):
    provider: Literal["youtube"]
    id: str


class MediaMetadata(_StrictModel):
    title: str
    duration: float | None


class StreamCapability(_StrictModel):
    session: str
    relay_url: str
    delivery: Literal["progressive"]
    container: Literal["mp4"]
    mime_type: Literal["video/mp4"]
    supports_byte_ranges: Literal[True]
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    bitrate_kbps: float | None = None
    size_bytes: int | None = None
    video_codec: str
    audio_codec: str


class ResolveResponse(_StrictModel):
    media: MediaIdentity
    metadata: MediaMetadata
    streams: list[StreamCapability]
