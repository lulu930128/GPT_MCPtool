from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.errors import NotFoundError, OperationError
from memory_core.models import Record, Revision
from memory_core.schemas import RecordRead


def get_record_revision_snapshot(
    session: Session,
    record_id: str,
    revision_no: int,
    *,
    allow_restricted: bool,
) -> RecordRead:
    record = session.get(Record, record_id)
    if record is None or (
        not allow_restricted
        and (record.sensitivity == "restricted" or record.handling_policy == "company_restricted")
    ):
        raise NotFoundError("record")
    revision = session.scalar(
        select(Revision).where(
            Revision.target_type == "record",
            Revision.target_id == record_id,
            Revision.revision_no == revision_no,
        )
    )
    if revision is None or not isinstance(revision.new_data, dict):
        raise NotFoundError("record revision")
    try:
        snapshot = RecordRead.model_validate(revision.new_data)
    except ValueError as exc:
        raise OperationError(
            "The stored record revision is not readable",
            code="invalid_record_revision",
        ) from exc
    if not allow_restricted and (
        snapshot.sensitivity == "restricted" or snapshot.handling_policy == "company_restricted"
    ):
        raise NotFoundError("record revision")
    return snapshot
