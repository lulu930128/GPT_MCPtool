from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from memory_core.record_schemas.base import (
    RecordSchemaValidationIssue,
    payload_field_path,
    scalar_error_value,
)

MediaType = Literal["galgame", "anime", "manga"]
MediaProgress = Literal["planned", "in_progress", "completed", "paused", "dropped"]
MediaRating = Annotated[float, Field(ge=0, le=10, multiple_of=0.5)]
StableEntityRef = Annotated[str, Field(pattern=r"^entity:[^:]+$", max_length=200)]
MediaAlias = Annotated[str, Field(min_length=1, max_length=300)]
MediaTag = Annotated[str, Field(min_length=1, max_length=120)]


def _normalize_unique_text_list(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    normalized: list[Any] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            normalized.append(item)
            continue
        stripped = item.strip()
        if not stripped or stripped.casefold() in seen:
            continue
        normalized.append(stripped)
        seen.add(stripped.casefold())
    return normalized


class MediaPayloadModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        allow_inf_nan=False,
    )


class MediaExperiencePayloadV1(MediaPayloadModel):
    canonical_entity_ref: StableEntityRef | None = Field(
        default=None,
        description=(
            "Compatibility projection of the canonical Work Entity; relational links "
            "remain authoritative."
        ),
    )
    work_title: str | None = Field(
        default=None,
        min_length=1,
        max_length=300,
        description="Display title of the work this experience is about.",
    )
    media_type: MediaType | None = Field(
        default=None, description="Supported media category used for identity and domain routing."
    )
    progress: MediaProgress = Field(description="Current user progress for this work.")
    user_category: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
        description="Optional user-defined classification within the media type.",
    )
    completed_on: date | None = Field(
        default=None,
        description="Completion date when known; it does not invent missing precision.",
    )
    aliases: list[MediaAlias] = Field(
        default_factory=list,
        max_length=50,
        description="Trimmed, case-insensitively de-duplicated alternate work titles.",
    )
    rating: MediaRating | None = Field(
        default=None,
        description="Optional user rating from 0 to 10 in 0.5 increments.",
    )
    evaluation_note: str | None = Field(
        default=None,
        max_length=10_000,
        description="Optional user evaluation or experience note.",
    )
    tags: list[MediaTag] = Field(
        default_factory=list,
        max_length=50,
        description="Trimmed, case-insensitively de-duplicated search tags.",
    )

    @field_validator("aliases", "tags", mode="before")
    @classmethod
    def normalize_text_lists(cls, value: Any) -> Any:
        return _normalize_unique_text_list(value)

    @model_validator(mode="after")
    def require_identity(self) -> MediaExperiencePayloadV1:
        if self.canonical_entity_ref is None and self.work_title is None:
            raise ValueError("media experience requires canonical_entity_ref or work_title.")
        return self


def media_validation_issue(error: ValidationError) -> RecordSchemaValidationIssue:
    first = error.errors(include_url=False)[0]
    location = tuple(first.get("loc") or ())
    error_type = str(first.get("type") or "")
    last = str(location[-1]) if location else ""
    code = "invalid_media_experience_schema"
    message = "Media experience payload failed validation."
    example: object | None = None
    if last == "work_title":
        code = "media_work_title_required"
        message = "work_title must not be empty."
        example = "Summer Pockets"
    elif last == "media_type":
        code = "invalid_media_type"
        message = "media_type must be galgame, anime, or manga."
        example = "galgame"
    elif last == "progress":
        code = "invalid_media_progress"
        message = "progress is not supported."
        example = "completed"
    elif last == "completed_on":
        code = "invalid_media_completion_date"
        message = "completed_on must be an ISO 8601 date."
        example = "2026-07-29"
    elif last == "rating":
        code = "invalid_media_rating"
        message = "rating must be from 0 to 10 in 0.5 increments."
        example = 8.5
    elif error_type == "extra_forbidden":
        message = "Unknown media experience payload field."
    elif error_type == "value_error":
        code = "media_identity_required"
        message = "Provide canonical_entity_ref or work_title."
        example = {"work_title": "Summer Pockets"}
    return RecordSchemaValidationIssue(
        code=code,
        field=payload_field_path(location),
        message=message,
        received_value=scalar_error_value(first.get("input")),
        example=example,
    )
