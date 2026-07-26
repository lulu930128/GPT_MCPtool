from __future__ import annotations

from sqlalchemy import func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.sql.base import Executable
from sqlalchemy.sql.elements import ColumnElement

from memory_core.db_types import utc_now
from memory_core.models import Entity, MemoryCandidate, Record
from memory_core.schemas import (
    CandidateStatusCounts,
    EntityOverviewCounts,
    MemoryIndexOverview,
    MemoryOverview,
    RecordOverviewCounts,
)
from memory_core.taxonomy import domain_taxonomy_status

CANDIDATE_STATUSES = ("pending", "applied", "rejected", "conflict", "expired")


def get_memory_overview(
    session: Session,
    *,
    allow_restricted: bool,
) -> MemoryOverview:
    record_visibility: list[ColumnElement[bool]] = []
    entity_visibility: list[ColumnElement[bool]] = []
    if not allow_restricted:
        record_visibility.extend(
            (
                Record.sensitivity != "restricted",
                Record.handling_policy != "company_restricted",
            )
        )
        entity_visibility.extend(
            (
                Entity.sensitivity != "restricted",
                Entity.handling_policy != "company_restricted",
            )
        )

    records_active = _scalar_count(
        session,
        select(func.count(Record.id)).where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status == "active",
        ),
    )
    records_superseded = _scalar_count(
        session,
        select(func.count(Record.id)).where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status == "superseded",
        ),
    )
    records_archived = _scalar_count(
        session,
        select(func.count(Record.id)).where(
            *record_visibility,
            Record.deleted_at.is_not(None),
        ),
    )
    entities_active = _scalar_count(
        session,
        select(func.count(Entity.id)).where(
            *entity_visibility,
            Entity.deleted_at.is_(None),
        ),
    )
    entities_archived = _scalar_count(
        session,
        select(func.count(Entity.id)).where(
            *entity_visibility,
            Entity.deleted_at.is_not(None),
        ),
    )

    domain_rows = session.execute(
        select(Record.domain, func.count(Record.id))
        .where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status == "active",
        )
        .group_by(Record.domain)
        .order_by(Record.domain)
    )
    domains = {domain: int(count) for domain, count in domain_rows}

    schema_rows = session.execute(
        select(Record.schema_name, Record.schema_version, func.count(Record.id))
        .where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status == "active",
        )
        .group_by(Record.schema_name, Record.schema_version)
        .order_by(Record.schema_name, Record.schema_version)
    )
    schema_versions = {
        f"{schema_name}@{schema_version}": int(count)
        for schema_name, schema_version, count in schema_rows
    }

    searchable_records = _scalar_count(
        session,
        select(func.count(Record.id)).where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status != "superseded",
        ),
    )
    latest_record_updated_at = session.scalar(
        select(func.max(Record.updated_at)).where(
            *record_visibility,
            Record.deleted_at.is_(None),
            Record.lifecycle_status != "superseded",
        )
    )
    index_status = "unavailable"
    indexed_records = 0
    try:
        privacy_clause = (
            ""
            if allow_restricted
            else ("AND r.sensitivity != 'restricted' AND r.handling_policy != 'company_restricted'")
        )
        indexed_records = int(
            session.scalar(
                text(
                    f"""
                    SELECT COUNT(*)
                    FROM records_fts
                    JOIN records AS r ON r.rowid = records_fts.rowid
                    WHERE r.deleted_at IS NULL
                      AND r.lifecycle_status != 'superseded'
                      {privacy_clause}
                    """
                )
            )
            or 0
        )
        index_status = "healthy" if indexed_records == searchable_records else "out_of_sync"
    except OperationalError:
        session.rollback()

    return MemoryOverview(
        generated_at=utc_now(),
        scope="visible",
        restricted_included=allow_restricted,
        records=RecordOverviewCounts(
            active=records_active,
            superseded=records_superseded,
            archived=records_archived,
        ),
        entities=EntityOverviewCounts(
            active=entities_active,
            archived=entities_archived,
        ),
        domains=domains,
        domain_taxonomy={domain: domain_taxonomy_status(domain) for domain in domains},
        schema_versions=schema_versions,
        index=MemoryIndexOverview(
            status=index_status,
            engine="sqlite_fts5",
            searchable_records=searchable_records,
            indexed_records=indexed_records,
            last_indexed_at=(latest_record_updated_at if index_status != "unavailable" else None),
        ),
    )


def get_candidate_status_counts(session: Session) -> CandidateStatusCounts:
    counts = {status: 0 for status in CANDIDATE_STATUSES}
    rows = session.execute(
        select(MemoryCandidate.status, func.count(MemoryCandidate.id)).group_by(
            MemoryCandidate.status
        )
    )
    for status, count in rows:
        if status in counts:
            counts[status] = int(count)
    return CandidateStatusCounts(**counts)


def _scalar_count(session: Session, statement: Executable) -> int:
    return int(session.scalar(statement) or 0)
