from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from memory_core.db import Base
from memory_core.db_types import UtcDateTime, utc_now


def new_id() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False
    )


class ClientCredential(Base):
    __tablename__ = "client_credentials"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)


class Record(TimestampMixin, Base):
    __tablename__ = "records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    domain: Mapped[str] = mapped_column(String(80), nullable=False, default="general")
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_start: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    occurred_end: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    date_precision: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    timezone_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    importance: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    lifecycle_status: Mapped[str] = mapped_column(String(30), nullable=False, default="active")
    verification_status: Mapped[str] = mapped_column(
        String(30), nullable=False, default="confirmed"
    )
    sensitivity: Mapped[str] = mapped_column(String(30), nullable=False, default="personal")
    handling_policy: Mapped[str] = mapped_column(String(40), nullable=False, default="normal")
    schema_name: Mapped[str] = mapped_column(String(100), nullable=False, default="generic")
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    source_type: Mapped[str] = mapped_column(String(40), nullable=False, default="manual")
    source_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    supersedes_id: Mapped[str | None] = mapped_column(
        ForeignKey("records.id", ondelete="SET NULL"), nullable=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    __table_args__ = (
        CheckConstraint("importance >= 0 AND importance <= 100", name="ck_records_importance"),
        CheckConstraint("version >= 1", name="ck_records_version"),
        CheckConstraint("schema_version >= 1", name="ck_records_schema_version"),
        CheckConstraint(
            "handling_policy != 'company_restricted' OR sensitivity = 'restricted'",
            name="ck_records_company_restricted",
        ),
        Index("ix_records_kind", "kind"),
        Index("ix_records_domain", "domain"),
        Index("ix_records_sensitivity", "sensitivity"),
        Index("ix_records_occurred_start", "occurred_start"),
        Index("ix_records_deleted_at", "deleted_at"),
    )


class Entity(TimestampMixin, Base):
    __tablename__ = "entities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    canonical_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    sensitivity: Mapped[str] = mapped_column(String(30), nullable=False, default="personal")
    handling_policy: Mapped[str] = mapped_column(String(40), nullable=False, default="normal")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_entities_version"),
        CheckConstraint(
            "handling_policy != 'company_restricted' OR sensitivity = 'restricted'",
            name="ck_entities_company_restricted",
        ),
        Index("ix_entities_type", "entity_type"),
        Index("ix_entities_name", "name"),
        Index("ix_entities_sensitivity", "sensitivity"),
        Index("ix_entities_deleted_at", "deleted_at"),
    )


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)


class RecordEntity(Base):
    __tablename__ = "record_entities"

    record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"), primary_key=True
    )
    entity_id: Mapped[str] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(80), primary_key=True, default="related")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)


class RecordTag(Base):
    __tablename__ = "record_tags"

    record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)


class EntityRelation(Base):
    __tablename__ = "entity_relations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    subject_entity_id: Mapped[str] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    predicate: Mapped[str] = mapped_column(String(120), nullable=False)
    object_entity_id: Mapped[str] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    valid_from: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    valid_to: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    source_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("records.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "subject_entity_id",
            "predicate",
            "object_entity_id",
            name="uq_entity_relation",
        ),
    )


class RecordLink(Base):
    __tablename__ = "record_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    subject_record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"), nullable=False
    )
    relation: Mapped[str] = mapped_column(String(120), nullable=False)
    object_record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "subject_record_id", "relation", "object_record_id", name="uq_record_link"
        ),
    )


class MemoryCandidate(Base):
    __tablename__ = "memory_candidates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    operation: Mapped[str] = mapped_column(String(20), nullable=False)
    target_type: Mapped[str] = mapped_column(String(20), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    base_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    proposed_content: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    source_type: Mapped[str] = mapped_column(String(40), nullable=False)
    source_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    review_digest: Mapped[str] = mapped_column(String(100), nullable=False)
    review_digest_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    confidence: Mapped[float | None] = mapped_column(nullable=True)
    validation_result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    risk_flags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    reviewed_by_client_id: Mapped[str | None] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=True
    )
    review_prepared_by_client_id: Mapped[str | None] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=True
    )
    review_challenge_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    review_challenge_expires_at: Mapped[datetime | None] = mapped_column(
        UtcDateTime(), nullable=True
    )
    review_action: Mapped[str | None] = mapped_column(String(20), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_idempotency_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    review_request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result_version: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_candidates_confidence",
        ),
        CheckConstraint(
            "operation IN ('create', 'update', 'archive')",
            name="ck_candidates_operation",
        ),
        CheckConstraint(
            "target_type IN ('record', 'entity')",
            name="ck_candidates_target_type",
        ),
        CheckConstraint(
            "status IN ('pending', 'applied', 'rejected', 'conflict', 'expired')",
            name="ck_candidates_status",
        ),
        CheckConstraint(
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL)",
            name="ck_candidates_target_shape",
        ),
        CheckConstraint("review_digest_version >= 1", name="ck_candidates_digest_version"),
        CheckConstraint(
            "result_version IS NULL OR result_version >= 1",
            name="ck_candidates_result_version",
        ),
        UniqueConstraint("source_client_id", "idempotency_key", name="uq_candidate_idempotency"),
        UniqueConstraint(
            "reviewed_by_client_id",
            "review_idempotency_key",
            name="uq_candidate_review_idempotency",
        ),
        Index("ix_memory_candidates_status", "status"),
        Index("ix_memory_candidates_target", "target_type", "target_id"),
        Index("ix_memory_candidates_expires_at", "expires_at"),
    )


class Revision(Base):
    __tablename__ = "revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    target_type: Mapped[str] = mapped_column(String(30), nullable=False)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False)
    revision_no: Mapped[int] = mapped_column(Integer, nullable=False)
    old_data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    new_data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    changed_by_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=False
    )
    change_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("target_type", "target_id", "revision_no", name="uq_revision_no"),
        Index("ix_revisions_target", "target_type", "target_id"),
    )


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    client_id: Mapped[str | None] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    outcome: Mapped[str] = mapped_column(String(30), nullable=False)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (
        Index("ix_audit_events_created_at", "created_at"),
        Index("ix_audit_events_target", "target_type", "target_id"),
    )


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"), nullable=False
    )
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_path: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(200), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    sensitivity: Mapped[str] = mapped_column(String(30), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (Index("ix_attachments_content_hash", "content_hash"),)


class ExportManifest(Base):
    __tablename__ = "export_manifests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    operation_type: Mapped[str] = mapped_column(String(30), nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    counts: Mapped[dict[str, int]] = mapped_column(JSON, nullable=False, default=dict)
    created_by_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
