from __future__ import annotations

import pytest
from pydantic import ValidationError

from memory_core.errors import DomainError
from memory_core.normalization.models import MediaExperienceBatchItemInput
from memory_core.normalization.profiles import (
    get_normalization_profile,
    registered_profile_keys,
    validate_registered_profiles,
)
from memory_core.record_schemas.media import MediaExperiencePayloadV1
from memory_core.services.batch_errors import project_batch_execution_error


def test_batch_execution_error_redacts_local_paths_and_secrets() -> None:
    error = DomainError(
        503,
        "backend_unavailable",
        (
            r"Could not open C:\Users\ExampleUser\private\memory.db; "
            "token=top-secret-value; Authorization=Bearer abcdefghijklmnop"
        ),
    )

    projected = project_batch_execution_error(error)

    assert projected.code == "backend_unavailable"
    assert projected.retry_policy == "retry_same_plan"
    assert "thoma" not in projected.message
    assert "top-secret-value" not in projected.message
    assert "abcdefghijklmnop" not in projected.message
    assert "[secret hidden]" in projected.message


def test_unknown_batch_execution_error_does_not_persist_exception_text() -> None:
    projected = project_batch_execution_error(
        RuntimeError(r"sqlite failed at C:\Users\ExampleUser\private\memory.db")
    )

    assert projected.code == "batch_item_apply_failed"
    assert projected.message == "Batch item execution failed."
    assert projected.retry_policy == "new_batch_required"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("aliases", ["a" * 301]),
        ("tags", ["t" * 121]),
        ("evaluation_note", "n" * 10_001),
    ],
)
def test_batch_media_item_rejects_unbounded_text(
    field: str,
    value: object,
) -> None:
    payload: dict[str, object] = {
        "work_title": "Summer Pockets",
        "media_type": "galgame",
        "progress": "completed",
        field: value,
    }

    with pytest.raises(ValidationError):
        MediaExperienceBatchItemInput.model_validate(payload)


def test_formal_media_record_schema_uses_the_same_text_limits() -> None:
    with pytest.raises(ValidationError):
        MediaExperiencePayloadV1.model_validate(
            {
                "work_title": "Summer Pockets",
                "media_type": "galgame",
                "progress": "completed",
                "evaluation_note": "n" * 10_001,
            }
        )


def test_profile_registry_validates_declared_handlers_and_hashes() -> None:
    assert registered_profile_keys() == (("media.experience.v1", 1),)
    validate_registered_profiles()
    profile = get_normalization_profile("media.experience.v1", 1)
    assert profile.handler == "media_experience_v1"
    assert profile.profile_hash.startswith("sha256:")

    with pytest.raises(ValueError, match="Unsupported normalization profile"):
        get_normalization_profile("unknown.profile", 1)
