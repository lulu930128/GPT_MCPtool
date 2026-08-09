from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from memory_core.record_schemas.base import RecordSchemaValidationIssue
from memory_core.record_schemas.cocktail import (
    CocktailPreferencePayloadV1,
    CocktailRecipePayloadV1,
    CocktailTastingPayloadV1,
    cocktail_validation_issue,
)
from memory_core.record_schemas.media import (
    MediaExperiencePayloadV1,
    media_validation_issue,
)


@dataclass(frozen=True, slots=True)
class RecordReferenceField:
    path: tuple[str, ...]
    relation: str
    target_schema_name: str
    target_schema_version: int
    collection: bool = False
    result_version_path: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class RecordSchemaDefinition:
    name: str
    version: int
    domain: str
    kind: str
    payload_model: type[BaseModel]
    reference_fields: tuple[RecordReferenceField, ...] = ()
    allowed_domains: tuple[str, ...] = ()
    allowed_kinds: tuple[str, ...] = ()


SCHEMA_REGISTRY: dict[tuple[str, int], RecordSchemaDefinition] = {
    ("cocktail_recipe", 1): RecordSchemaDefinition(
        name="cocktail_recipe",
        version=1,
        domain="lifestyle.cocktail",
        kind="fact",
        payload_model=CocktailRecipePayloadV1,
        reference_fields=(
            RecordReferenceField(
                path=("parent_recipe_ref",),
                relation="derived_from",
                target_schema_name="cocktail_recipe",
                target_schema_version=1,
            ),
        ),
    ),
    ("cocktail_tasting", 1): RecordSchemaDefinition(
        name="cocktail_tasting",
        version=1,
        domain="lifestyle.cocktail",
        kind="event",
        payload_model=CocktailTastingPayloadV1,
        reference_fields=(
            RecordReferenceField(
                path=("recipe_ref",),
                relation="uses_recipe",
                target_schema_name="cocktail_recipe",
                target_schema_version=1,
                result_version_path=("recipe_version",),
            ),
        ),
    ),
    ("cocktail_preference", 1): RecordSchemaDefinition(
        name="cocktail_preference",
        version=1,
        domain="lifestyle.cocktail",
        kind="state",
        payload_model=CocktailPreferencePayloadV1,
        reference_fields=(
            RecordReferenceField(
                path=("confirmed_favorite_recipe_refs",),
                relation="favorite_recipe",
                target_schema_name="cocktail_recipe",
                target_schema_version=1,
                collection=True,
            ),
        ),
    ),
    ("media_experience", 1): RecordSchemaDefinition(
        name="media_experience",
        version=1,
        domain="media.galgame",
        allowed_domains=("media.galgame", "media.anime", "media.manga"),
        kind="state",
        allowed_kinds=("state", "fact"),
        payload_model=MediaExperiencePayloadV1,
    ),
}
REGISTERED_SCHEMA_NAMES = frozenset(name for name, _version in SCHEMA_REGISTRY)


def get_record_schema_definition(
    schema_name: str,
    schema_version: int,
) -> RecordSchemaDefinition | None:
    definition = SCHEMA_REGISTRY.get((schema_name, schema_version))
    if definition is not None:
        return definition
    if schema_name in REGISTERED_SCHEMA_NAMES:
        raise RecordSchemaValidationIssue(
            code="unsupported_record_schema_version",
            field="schema_version",
            message=f"{schema_name}@{schema_version} is not a supported Record Schema.",
            received_value=schema_version,
            example=1,
        )
    return None


def normalize_registered_payload(
    *,
    schema_name: str,
    schema_version: int,
    domain: str,
    kind: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    definition = get_record_schema_definition(schema_name, schema_version)
    if definition is None:
        return payload
    allowed_domains = definition.allowed_domains or (definition.domain,)
    if domain not in allowed_domains:
        raise RecordSchemaValidationIssue(
            code="invalid_record_schema_envelope",
            field="domain",
            message=(
                f"{schema_name}@{schema_version} requires one of {', '.join(allowed_domains)}."
            ),
            received_value=domain,
            example=definition.domain,
        )
    allowed_kinds = definition.allowed_kinds or (definition.kind,)
    if kind not in allowed_kinds:
        raise RecordSchemaValidationIssue(
            code="invalid_record_schema_envelope",
            field="kind",
            message=(f"{schema_name}@{schema_version} requires one of {', '.join(allowed_kinds)}."),
            received_value=kind,
            example=definition.kind,
        )
    if schema_name == "media_experience" and not payload:
        return payload
    try:
        normalized = definition.payload_model.model_validate(payload)
    except ValidationError as exc:
        if schema_name.startswith("cocktail_"):
            issue = cocktail_validation_issue(schema_name, exc)
        elif schema_name == "media_experience":
            issue = media_validation_issue(exc)
        else:  # pragma: no cover - registry entries always select an error adapter
            raise
        raise issue from exc
    dumped = normalized.model_dump(mode="json")
    if not isinstance(dumped, dict):  # pragma: no cover - payload models are objects
        raise TypeError("Record Schema payload must serialize to an object")
    return dumped
