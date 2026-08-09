from __future__ import annotations

import json
from importlib.resources import files

from pydantic import BaseModel, ConfigDict, Field, model_validator

from memory_core.normalization.canonical import sha256_digest


class NormalizationProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    profile_id: str = Field(min_length=1, max_length=160)
    profile_version: int = Field(ge=1)
    handler: str = Field(min_length=1, max_length=100)
    normalizer_version: str = Field(min_length=1, max_length=40)
    min_items: int = Field(ge=1, le=50)
    max_items: int = Field(ge=1, le=50)
    identity_strategy: str = Field(min_length=1, max_length=100)
    profile_hash: str

    @model_validator(mode="after")
    def validate_item_bounds(self) -> NormalizationProfile:
        if self.min_items > self.max_items:
            raise ValueError("Normalization profile min_items cannot exceed max_items.")
        return self


_PROFILE_FILES = {
    ("media.experience.v1", 1): "media.experience.v1.1.json",
}
_ALLOWED_HANDLERS = {
    "media_experience_v1",
}
_ALLOWED_IDENTITY_STRATEGIES = {
    "media_type_and_normalized_title",
}


def _load_profile_document(profile_id: str, profile_version: int) -> dict[str, object]:
    filename = _PROFILE_FILES.get((profile_id, profile_version))
    if filename is None:
        raise ValueError(f"Unsupported normalization profile: {profile_id}@{profile_version}")
    resource = files("memory_core.normalization").joinpath("profiles", filename)
    try:
        raw = resource.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ValueError(
            f"Unsupported normalization profile: {profile_id}@{profile_version}"
        ) from exc
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError("Normalization profile must be a JSON object.")
    return document


def get_normalization_profile(profile_id: str, profile_version: int) -> NormalizationProfile:
    document = _load_profile_document(profile_id, profile_version)
    declared_hash = document.pop("profile_hash", None)
    actual_hash = sha256_digest(document)
    if declared_hash != actual_hash:
        raise ValueError(f"Normalization profile hash mismatch for {profile_id}@{profile_version}.")
    document["profile_hash"] = actual_hash
    profile = NormalizationProfile.model_validate(document)
    if profile.profile_id != profile_id or profile.profile_version != profile_version:
        raise ValueError("Normalization profile identity does not match the registry entry.")
    if profile.handler not in _ALLOWED_HANDLERS:
        raise ValueError(f"Normalization profile handler is not allowed: {profile.handler}")
    if profile.identity_strategy not in _ALLOWED_IDENTITY_STRATEGIES:
        raise ValueError(
            f"Normalization profile identity strategy is not allowed: {profile.identity_strategy}"
        )
    return profile


def registered_profile_keys() -> tuple[tuple[str, int], ...]:
    return tuple(sorted(_PROFILE_FILES))


def validate_registered_profiles() -> None:
    for profile_id, profile_version in registered_profile_keys():
        get_normalization_profile(profile_id, profile_version)
