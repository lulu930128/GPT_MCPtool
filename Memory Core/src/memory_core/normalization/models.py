from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from memory_core.record_schemas.media import MediaProgress, MediaRating, MediaType

StableEntityRef = Annotated[str, Field(pattern=r"^entity:[^:]+$", max_length=200)]
StableRecordRef = Annotated[str, Field(pattern=r"^record:[^:]+$", max_length=200)]
MediaAlias = Annotated[str, Field(min_length=1, max_length=300)]
MediaTag = Annotated[str, Field(min_length=1, max_length=120)]


class NormalizationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class MediaExperienceResolution(NormalizationModel):
    target_entity_ref: StableEntityRef | None = None
    target_record_ref: StableRecordRef | None = None
    expected_record_version: int | None = Field(default=None, ge=1)
    force_create: bool = False
    exclude: bool = False

    @model_validator(mode="after")
    def validate_resolution(self) -> MediaExperienceResolution:
        if self.exclude and (
            self.target_entity_ref is not None
            or self.target_record_ref is not None
            or self.expected_record_version is not None
            or self.force_create
        ):
            raise ValueError("exclude cannot be combined with another resolution.")
        if self.force_create and (
            self.target_entity_ref is not None or self.target_record_ref is not None
        ):
            raise ValueError("force_create cannot be combined with an explicit target.")
        if self.expected_record_version is not None and self.target_record_ref is None:
            raise ValueError("expected_record_version requires target_record_ref.")
        return self


class MediaExperienceBatchItemInput(NormalizationModel):
    client_item_id: str | None = Field(default=None, min_length=1, max_length=120)
    work_title: str = Field(min_length=1, max_length=300)
    media_type: MediaType
    progress: MediaProgress
    user_category: str | None = Field(default=None, min_length=1, max_length=120)
    completed_on: date | None = None
    aliases: list[MediaAlias] = Field(default_factory=list, max_length=50)
    rating: MediaRating | None = None
    evaluation_note: str | None = Field(default=None, max_length=10_000)
    tags: list[MediaTag] = Field(default_factory=list, max_length=50)
    source_reference: str | None = Field(default=None, max_length=1000)
    resolution: MediaExperienceResolution | None = None


class MediaExperienceBatchProposal(NormalizationModel):
    profile_id: Literal["media.experience.v1"] = "media.experience.v1"
    profile_version: Literal[1] = 1
    summary: str | None = Field(default=None, max_length=500)
    items: list[MediaExperienceBatchItemInput] = Field(min_length=1, max_length=50)


BatchChangeType = Literal[
    "record_create",
    "record_update",
    "entity_create",
    "entity_update",
    "record_entity_link_upsert",
    "collection_member_upsert",
]


class BatchOperationPlan(NormalizationModel):
    op_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    position: int = Field(ge=0)
    change_type: BatchChangeType
    change_data: dict[str, Any]


class BatchPlanWarning(NormalizationModel):
    code: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=500)
    field: str | None = Field(default=None, max_length=200)


class BatchUnitPlan(NormalizationModel):
    unit_key: str = Field(min_length=1, max_length=200)
    source_index: int = Field(ge=0)
    input_snapshot: dict[str, Any]
    normalized_snapshot: dict[str, Any]
    input_hash: str = Field(min_length=1, max_length=100)
    plan_hash: str = Field(min_length=1, max_length=100)
    decision: Literal["create", "update", "noop", "conflict", "invalid", "excluded"]
    operations: list[BatchOperationPlan] = Field(default_factory=list)
    warnings: list[BatchPlanWarning] = Field(default_factory=list)
    error_code: str | None = Field(default=None, max_length=80)
    error_message: str | None = None


class BatchPlan(NormalizationModel):
    profile_id: str
    profile_version: int = Field(ge=1)
    profile_hash: str
    normalizer_version: str
    input_hash: str
    plan_hash: str
    state: Literal["blocked", "ready"]
    items: list[BatchUnitPlan]
