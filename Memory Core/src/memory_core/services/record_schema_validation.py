from __future__ import annotations

from typing import NoReturn

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.errors import NotFoundError, operation_error_from_record_schema
from memory_core.models import Record
from memory_core.record_schemas import (
    REGISTERED_SCHEMA_NAMES,
    CocktailPreferencePayloadV1,
    CocktailRecipePayloadV1,
    CocktailTastingPayloadV1,
    RecordSchemaValidationIssue,
    normalize_registered_payload,
)
from memory_core.schemas import RecordCreate, RecordRead, RecordUpdatePatch
from memory_core.services.revisions import get_record_revision_snapshot

COCKTAIL_RECIPE_SCHEMA = "cocktail_recipe"
COCKTAIL_TASTING_SCHEMA = "cocktail_tasting"
COCKTAIL_PREFERENCE_SCHEMA = "cocktail_preference"
COCKTAIL_SCHEMA_VERSION = 1


def _raise_issue(
    *,
    code: str,
    field: str,
    message: str,
    received_value: object | None = None,
    example: object | None = None,
) -> NoReturn:
    issue = RecordSchemaValidationIssue(
        code=code,
        field=field,
        message=message,
        received_value=received_value,
        example=example,
    )
    raise operation_error_from_record_schema(issue)


def _parse_record_ref(value: str, *, field: str, code: str) -> str:
    result_type, separator, record_id = value.partition(":")
    if separator != ":" or result_type != "record" or not record_id:
        _raise_issue(
            code=code,
            field=field,
            message="Reference must use record:<id>.",
            received_value=value,
            example="record:<recipe-id>",
        )
    return record_id


def _get_visible_recipe(
    session: Session,
    recipe_ref: str,
    *,
    field: str,
    code: str,
    allow_restricted: bool,
    allow_archived: bool,
) -> Record:
    record_id = _parse_record_ref(recipe_ref, field=field, code=code)
    recipe = session.get(Record, record_id)
    hidden = (
        recipe is not None
        and not allow_restricted
        and (recipe.sensitivity == "restricted" or recipe.handling_policy == "company_restricted")
    )
    if (
        recipe is None
        or hidden
        or recipe.schema_name != COCKTAIL_RECIPE_SCHEMA
        or recipe.schema_version != COCKTAIL_SCHEMA_VERSION
        or (recipe.deleted_at is not None and not allow_archived)
    ):
        _raise_issue(
            code=code,
            field=field,
            message="Reference must point to a visible Cocktail Recipe v1 Record.",
            received_value=recipe_ref,
            example="record:<active-cocktail-recipe-id>",
        )
    return recipe


def resolve_cocktail_recipe_revision(
    session: Session,
    recipe_ref: str,
    recipe_version: int,
    *,
    allow_restricted: bool,
    allow_archived: bool,
) -> RecordRead:
    recipe = _get_visible_recipe(
        session,
        recipe_ref,
        field="payload.recipe_ref",
        code="invalid_recipe_reference",
        allow_restricted=allow_restricted,
        allow_archived=allow_archived,
    )
    try:
        revision = get_record_revision_snapshot(
            session,
            recipe.id,
            recipe_version,
            allow_restricted=allow_restricted,
        )
    except NotFoundError:
        _raise_issue(
            code="invalid_recipe_version",
            field="payload.recipe_version",
            message="recipe_version does not exist for the referenced Cocktail Recipe.",
            received_value=recipe_version,
            example=recipe.version,
        )
    if (
        revision.schema_name != COCKTAIL_RECIPE_SCHEMA
        or revision.schema_version != COCKTAIL_SCHEMA_VERSION
    ):
        _raise_issue(
            code="invalid_recipe_version",
            field="payload.recipe_version",
            message="The referenced revision is not a Cocktail Recipe v1 snapshot.",
            received_value=recipe_version,
            example=recipe.version,
        )
    return revision


def _validate_recipe_parent(
    session: Session,
    payload: CocktailRecipePayloadV1,
    *,
    target_id: str | None,
    allow_restricted: bool,
) -> None:
    if payload.parent_recipe_ref is None:
        return
    parent = _get_visible_recipe(
        session,
        payload.parent_recipe_ref,
        field="payload.parent_recipe_ref",
        code="invalid_recipe_reference",
        allow_restricted=allow_restricted,
        allow_archived=False,
    )
    visited = {target_id} if target_id is not None else set()
    while True:
        if parent.id in visited:
            _raise_issue(
                code="recipe_reference_cycle",
                field="payload.parent_recipe_ref",
                message="parent_recipe_ref must not create a Recipe reference cycle.",
                received_value=payload.parent_recipe_ref,
            )
        visited.add(parent.id)
        parent_payload = CocktailRecipePayloadV1.model_validate(parent.payload)
        if parent_payload.parent_recipe_ref is None:
            return
        parent = _get_visible_recipe(
            session,
            parent_payload.parent_recipe_ref,
            field="payload.parent_recipe_ref",
            code="invalid_recipe_reference",
            allow_restricted=allow_restricted,
            allow_archived=False,
        )


def _validate_tasting_reference(
    session: Session,
    payload: CocktailTastingPayloadV1,
    *,
    allow_restricted: bool,
) -> None:
    if payload.recipe_ref is None or payload.recipe_version is None:
        return
    resolve_cocktail_recipe_revision(
        session,
        payload.recipe_ref,
        payload.recipe_version,
        allow_restricted=allow_restricted,
        allow_archived=False,
    )


def _validate_preference_references(
    session: Session,
    payload: CocktailPreferencePayloadV1,
    *,
    allow_restricted: bool,
) -> None:
    for index, recipe_ref in enumerate(payload.confirmed_favorite_recipe_refs):
        _get_visible_recipe(
            session,
            recipe_ref,
            field=f"payload.confirmed_favorite_recipe_refs[{index}]",
            code="invalid_favorite_recipe_reference",
            allow_restricted=allow_restricted,
            allow_archived=False,
        )


def _validate_preference_singleton(
    session: Session,
    *,
    target_id: str | None,
    allow_restricted: bool,
) -> None:
    statement = select(Record).where(
        Record.schema_name == COCKTAIL_PREFERENCE_SCHEMA,
        Record.schema_version == COCKTAIL_SCHEMA_VERSION,
        Record.domain == "lifestyle.cocktail",
        Record.lifecycle_status == "active",
        Record.deleted_at.is_(None),
    )
    if target_id is not None:
        statement = statement.where(Record.id != target_id)
    existing = session.scalar(statement.order_by(Record.created_at.asc()).limit(1))
    if existing is None:
        return
    if not allow_restricted and (
        existing.sensitivity == "restricted" or existing.handling_policy == "company_restricted"
    ):
        existing_ref = "record:<existing-preference>"
    else:
        existing_ref = f"record:{existing.id}"
    _raise_issue(
        code="cocktail_preference_singleton_conflict",
        field="schema_name",
        message=(
            "An active Cocktail Preference already exists. Fetch it and propose an update "
            f"instead: {existing_ref}"
        ),
        received_value=COCKTAIL_PREFERENCE_SCHEMA,
        example=existing_ref,
    )


def normalize_record_schema_create(
    session: Session,
    payload: RecordCreate,
    *,
    target_id: str | None = None,
    allow_restricted: bool,
    validate_references: bool = True,
) -> RecordCreate:
    try:
        normalized_payload = normalize_registered_payload(
            schema_name=payload.schema_name,
            schema_version=payload.schema_version,
            domain=payload.domain,
            kind=payload.kind.value,
            payload=payload.payload,
        )
    except RecordSchemaValidationIssue as issue:
        raise operation_error_from_record_schema(issue) from issue
    normalized = payload.model_copy(update={"payload": normalized_payload})
    if payload.schema_name == COCKTAIL_RECIPE_SCHEMA:
        if validate_references:
            _validate_recipe_parent(
                session,
                CocktailRecipePayloadV1.model_validate(normalized_payload),
                target_id=target_id,
                allow_restricted=allow_restricted,
            )
    elif payload.schema_name == COCKTAIL_TASTING_SCHEMA:
        if payload.occurred_start is None:
            _raise_issue(
                code="tasting_time_required",
                field="occurred_start",
                message="Cocktail Tasting requires occurred_start.",
                example="2025-07-16T20:00:00+08:00",
            )
        if payload.timezone_name is None:
            _raise_issue(
                code="invalid_timezone_name",
                field="timezone_name",
                message="Cocktail Tasting requires an IANA timezone_name.",
                example="Asia/Taipei",
            )
        if validate_references:
            _validate_tasting_reference(
                session,
                CocktailTastingPayloadV1.model_validate(normalized_payload),
                allow_restricted=allow_restricted,
            )
    elif payload.schema_name == COCKTAIL_PREFERENCE_SCHEMA:
        if validate_references:
            _validate_preference_references(
                session,
                CocktailPreferencePayloadV1.model_validate(normalized_payload),
                allow_restricted=allow_restricted,
            )
        _validate_preference_singleton(
            session,
            target_id=target_id,
            allow_restricted=allow_restricted,
        )
    return normalized


def resolved_record_create(record: Record, patch: RecordUpdatePatch) -> RecordCreate:
    current = RecordRead.model_validate(record).model_dump(mode="python")
    values = {
        field_name: current[field_name]
        for field_name in RecordCreate.model_fields
        if field_name in current
    }
    for field_name in patch.model_fields_set:
        if field_name in values:
            values[field_name] = getattr(patch, field_name)
    return RecordCreate.model_validate(values)


def normalize_record_schema_update(
    session: Session,
    record: Record,
    patch: RecordUpdatePatch,
    *,
    allow_restricted: bool,
    validate_references: bool = True,
) -> tuple[RecordUpdatePatch, RecordCreate]:
    resolved = resolved_record_create(record, patch)
    registered_identity_involved = (
        record.schema_name in REGISTERED_SCHEMA_NAMES
        or resolved.schema_name in REGISTERED_SCHEMA_NAMES
    )
    if registered_identity_involved and (
        resolved.schema_name != record.schema_name
        or resolved.schema_version != record.schema_version
    ):
        _raise_issue(
            code="invalid_record_schema_envelope",
            field="schema_name",
            message=(
                "A registered Record Schema identity cannot be added, removed, or changed by "
                "update. Create a reviewed migration candidate instead."
            ),
            received_value=resolved.schema_name,
            example=record.schema_name,
        )
    normalized = normalize_record_schema_create(
        session,
        resolved,
        target_id=record.id,
        allow_restricted=allow_restricted,
        validate_references=validate_references,
    )
    schema_fields_changed = bool(
        patch.model_fields_set & {"schema_name", "schema_version", "payload"}
    )
    if not schema_fields_changed:
        return patch, normalized
    return patch.model_copy(update={"payload": normalized.payload}), normalized


def update_uses_registered_schema(record: Record, patch: RecordUpdatePatch) -> bool:
    prospective_name = (
        patch.schema_name if "schema_name" in patch.model_fields_set else record.schema_name
    )
    return (
        record.schema_name in REGISTERED_SCHEMA_NAMES or prospective_name in REGISTERED_SCHEMA_NAMES
    )
