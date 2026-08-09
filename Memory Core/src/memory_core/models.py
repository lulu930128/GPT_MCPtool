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
from sqlalchemy.orm import Mapped, mapped_column, relationship

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
    target_revision_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False
    )
    removed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    @property
    def link_ref(self) -> str:
        return f"link:{self.id}"

    @property
    def source_ref(self) -> str:
        return f"record:{self.subject_record_id}"

    @property
    def role(self) -> str:
        return self.relation

    @property
    def target_ref(self) -> str:
        return f"record:{self.object_record_id}"

    @property
    def status(self) -> str:
        return "removed" if self.removed_at is not None else "active"

    __table_args__ = (
        CheckConstraint(
            "target_revision_no IS NULL OR target_revision_no >= 1",
            name="ck_record_links_target_revision",
        ),
        UniqueConstraint(
            "subject_record_id", "relation", "object_record_id", name="uq_record_link"
        ),
        Index("ix_record_links_subject", "subject_record_id"),
        Index("ix_record_links_object", "object_record_id"),
        Index("ix_record_links_removed_at", "removed_at"),
    )


class MemoryCandidate(Base):
    __tablename__ = "memory_candidates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_kind: Mapped[str] = mapped_column(String(20), nullable=False, default="single")
    summary: Mapped[str | None] = mapped_column(String(500), nullable=True)
    operation: Mapped[str | None] = mapped_column(String(20), nullable=True)
    target_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
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
    operations: Mapped[list[CandidateOperation]] = relationship(
        back_populates="candidate",
        cascade="all, delete-orphan",
        order_by="CandidateOperation.position",
        lazy="selectin",
    )
    results: Mapped[list[CandidateResult]] = relationship(
        back_populates="candidate",
        cascade="all, delete-orphan",
        order_by="CandidateResult.position",
        lazy="selectin",
    )
    batch: Mapped[CandidateBatch | None] = relationship(
        back_populates="candidate",
        cascade="all, delete-orphan",
        uselist=False,
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_candidates_confidence",
        ),
        CheckConstraint(
            "(candidate_kind = 'single' AND operation IN ('create', 'update', 'archive')) OR "
            "(candidate_kind IN ('change_set', 'batch') AND operation IS NULL)",
            name="ck_candidates_operation",
        ),
        CheckConstraint(
            "(candidate_kind = 'single' AND target_type IN ('record', 'entity')) OR "
            "(candidate_kind IN ('change_set', 'batch') AND target_type IS NULL)",
            name="ck_candidates_target_type",
        ),
        CheckConstraint(
            "candidate_kind IN ('single', 'change_set', 'batch')",
            name="ck_candidates_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'applied', 'rejected', 'conflict', 'expired')",
            name="ck_candidates_status",
        ),
        CheckConstraint(
            "(candidate_kind = 'single' AND ("
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL))) OR "
            "(candidate_kind IN ('change_set', 'batch') "
            "AND target_id IS NULL AND base_version IS NULL)",
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


class CandidateOperation(Base):
    __tablename__ = "candidate_operations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(
        ForeignKey("memory_candidates.id", ondelete="CASCADE"),
        nullable=False,
    )
    op_id: Mapped[str] = mapped_column(String(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    change_type: Mapped[str] = mapped_column(String(40), nullable=False)
    change_data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    candidate: Mapped[MemoryCandidate] = relationship(back_populates="operations")

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_candidate_operations_position"),
        CheckConstraint(
            "change_type IN ('record_create', 'record_update')",
            name="ck_candidate_operations_change_type",
        ),
        UniqueConstraint("candidate_id", "op_id", name="uq_candidate_operation_op_id"),
        UniqueConstraint("candidate_id", "position", name="uq_candidate_operation_position"),
        Index("ix_candidate_operations_candidate", "candidate_id"),
    )


class CandidateResult(Base):
    __tablename__ = "candidate_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(
        ForeignKey("memory_candidates.id", ondelete="CASCADE"),
        nullable=False,
    )
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_operations.id", ondelete="CASCADE"),
        nullable=False,
    )
    op_id: Mapped[str] = mapped_column(String(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    change_type: Mapped[str] = mapped_column(String(40), nullable=False)
    result_type: Mapped[str] = mapped_column(String(20), nullable=False)
    result_id: Mapped[str] = mapped_column(String(36), nullable=False)
    result_version: Mapped[int] = mapped_column(Integer, nullable=False)
    candidate: Mapped[MemoryCandidate] = relationship(back_populates="results")

    @property
    def result_ref(self) -> str:
        return f"{self.result_type}:{self.result_id}"

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_candidate_results_position"),
        CheckConstraint("result_type IN ('record', 'entity')", name="ck_candidate_results_type"),
        CheckConstraint("result_version >= 1", name="ck_candidate_results_version"),
        UniqueConstraint("candidate_id", "op_id", name="uq_candidate_result_op_id"),
        UniqueConstraint("operation_id", name="uq_candidate_result_operation"),
        Index("ix_candidate_results_candidate", "candidate_id"),
    )


class CandidateBatch(Base):
    __tablename__ = "candidate_batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(
        ForeignKey("memory_candidates.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    profile_id: Mapped[str] = mapped_column(String(160), nullable=False)
    profile_version: Mapped[int] = mapped_column(Integer, nullable=False)
    profile_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    normalizer_version: Mapped[str] = mapped_column(String(40), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    current_revision_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    plan_state: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    review_state: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    execution_state: Mapped[str] = mapped_column(String(30), nullable=False, default="not_started")
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    candidate: Mapped[MemoryCandidate] = relationship(back_populates="batch")
    revisions: Mapped[list[CandidateBatchRevision]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="CandidateBatchRevision.revision_no",
        lazy="selectin",
    )
    items: Mapped[list[CandidateItem]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="CandidateItem.position",
        lazy="selectin",
    )
    apply_attempts: Mapped[list[BatchApplyAttempt]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="BatchApplyAttempt.created_at",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("profile_version >= 1", name="ck_candidate_batches_profile_version"),
        CheckConstraint(
            "current_revision_no >= 1",
            name="ck_candidate_batches_current_revision",
        ),
        CheckConstraint("item_count >= 0", name="ck_candidate_batches_item_count"),
        CheckConstraint(
            "plan_state IN ('draft', 'blocked', 'ready', 'sealed')",
            name="ck_candidate_batches_plan_state",
        ),
        CheckConstraint(
            "review_state IN ('pending', 'prepared', 'approved', 'rejected', 'expired')",
            name="ck_candidate_batches_review_state",
        ),
        CheckConstraint(
            "execution_state IN ("
            "'not_started', 'applying', 'applied', 'partially_applied', 'failed'"
            ")",
            name="ck_candidate_batches_execution_state",
        ),
        Index("ix_candidate_batches_candidate", "candidate_id"),
        Index("ix_candidate_batches_profile", "profile_id", "profile_version"),
        Index(
            "ix_candidate_batches_states",
            "plan_state",
            "review_state",
            "execution_state",
        ),
    )


class CandidateBatchRevision(Base):
    __tablename__ = "candidate_batch_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    revision_no: Mapped[int] = mapped_column(Integer, nullable=False)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    input_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    plan_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    review_digest: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sealed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    batch: Mapped[CandidateBatch] = relationship(back_populates="revisions")
    items: Mapped[list[CandidateItem]] = relationship(
        back_populates="batch_revision",
        cascade="all, delete-orphan",
        order_by="CandidateItem.position",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("revision_no >= 1", name="ck_candidate_batch_revisions_number"),
        UniqueConstraint(
            "batch_id",
            "revision_no",
            name="uq_candidate_batch_revision_number",
        ),
        Index("ix_candidate_batch_revisions_batch", "batch_id"),
    )


class CandidateItem(Base):
    __tablename__ = "candidate_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    batch_revision_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_batch_revisions.id", ondelete="CASCADE"),
        nullable=False,
    )
    unit_key: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    source_index: Mapped[int] = mapped_column(Integer, nullable=False)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    normalized_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    input_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(100), nullable=False)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    execution_state: Mapped[str] = mapped_column(String(20), nullable=False, default="not_started")
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    # Immutable planning diagnostics. These fields participate in plan_hash and must not be
    # overwritten by execution failures.
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    execution_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_policy: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="not_applicable",
    )
    claim_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    applied_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False
    )

    batch: Mapped[CandidateBatch] = relationship(back_populates="items")
    batch_revision: Mapped[CandidateBatchRevision] = relationship(back_populates="items")
    operations: Mapped[list[BatchItemOperation]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="BatchItemOperation.position",
        lazy="selectin",
    )
    results: Mapped[list[BatchItemResult]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="BatchItemResult.position",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_candidate_items_position"),
        CheckConstraint("source_index >= 0", name="ck_candidate_items_source_index"),
        CheckConstraint("attempt_count >= 0", name="ck_candidate_items_attempt_count"),
        CheckConstraint(
            "decision IN ('create', 'update', 'noop', 'conflict', 'invalid', 'excluded')",
            name="ck_candidate_items_decision",
        ),
        CheckConstraint(
            "execution_state IN ("
            "'not_started', 'claimed', 'applied', 'failed', 'unverified', 'skipped'"
            ")",
            name="ck_candidate_items_execution_state",
        ),
        CheckConstraint(
            "retry_policy IN ("
            "'not_applicable', 'retry_same_plan', 'verify_only', 'new_batch_required'"
            ")",
            name="ck_candidate_items_retry_policy",
        ),
        UniqueConstraint(
            "batch_revision_id",
            "position",
            name="uq_candidate_item_position",
        ),
        Index("ix_candidate_items_batch", "batch_id", "position"),
        Index("ix_candidate_items_revision", "batch_revision_id", "position"),
        Index("ix_candidate_items_unit_key", "batch_revision_id", "unit_key"),
        Index("ix_candidate_items_state", "batch_id", "execution_state"),
    )


class BatchItemOperation(Base):
    __tablename__ = "batch_item_operations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_item_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    op_id: Mapped[str] = mapped_column(String(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    change_type: Mapped[str] = mapped_column(String(40), nullable=False)
    change_data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    item: Mapped[CandidateItem] = relationship(back_populates="operations")
    result: Mapped[BatchItemResult | None] = relationship(
        back_populates="operation",
        cascade="all, delete-orphan",
        uselist=False,
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_batch_item_operations_position"),
        CheckConstraint(
            "change_type IN ("
            "'record_create', 'record_update', "
            "'entity_create', 'entity_update', "
            "'record_entity_link_upsert', 'collection_member_upsert'"
            ")",
            name="ck_batch_item_operations_change_type",
        ),
        UniqueConstraint(
            "candidate_item_id",
            "op_id",
            name="uq_batch_item_operation_op_id",
        ),
        UniqueConstraint(
            "candidate_item_id",
            "position",
            name="uq_batch_item_operation_position",
        ),
        Index("ix_batch_item_operations_item", "candidate_item_id", "position"),
    )


class BatchItemResult(Base):
    __tablename__ = "batch_item_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_item_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("batch_item_operations.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    op_id: Mapped[str] = mapped_column(String(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    operation_outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    result_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    result_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    result_locator: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    result_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    verify_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    verify_error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    item: Mapped[CandidateItem] = relationship(back_populates="results")
    operation: Mapped[BatchItemOperation] = relationship(back_populates="result")

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_batch_item_results_position"),
        CheckConstraint(
            "operation_outcome IN ('created', 'updated', 'archived', 'noop')",
            name="ck_batch_item_results_outcome",
        ),
        CheckConstraint(
            "result_kind IN ("
            "'record', 'entity', 'record_entity_link', 'record_link', "
            "'entity_relation', 'collection_member'"
            ")",
            name="ck_batch_item_results_kind",
        ),
        CheckConstraint(
            "result_version IS NULL OR result_version >= 1",
            name="ck_batch_item_results_version",
        ),
        CheckConstraint(
            "verify_status IN ('pending', 'verified', 'failed', 'not_applicable')",
            name="ck_batch_item_results_verify_status",
        ),
        UniqueConstraint(
            "candidate_item_id",
            "op_id",
            name="uq_batch_item_result_op_id",
        ),
        Index("ix_batch_item_results_item", "candidate_item_id", "position"),
    )


class BatchApplyAttempt(Base):
    __tablename__ = "batch_apply_attempts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    batch_revision_id: Mapped[str] = mapped_column(
        ForeignKey("candidate_batch_revisions.id", ondelete="CASCADE"),
        nullable=False,
    )
    reviewer_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"),
        nullable=False,
    )
    approval_idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    approval_request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")
    lease_token: Mapped[str] = mapped_column(String(100), nullable=False)
    lease_expires_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    batch: Mapped[CandidateBatch] = relationship(back_populates="apply_attempts")

    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'completed', 'interrupted', 'failed')",
            name="ck_batch_apply_attempts_status",
        ),
        UniqueConstraint(
            "reviewer_client_id",
            "approval_idempotency_key",
            name="uq_batch_apply_attempt_idempotency",
        ),
        Index("ix_batch_apply_attempts_batch", "batch_id", "created_at"),
        Index("ix_batch_apply_attempts_lease", "status", "lease_expires_at"),
    )


class MemoryCollection(TimestampMixin, Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    domain: Mapped[str | None] = mapped_column(String(80), nullable=True)
    lifecycle_status: Mapped[str] = mapped_column(String(30), nullable=False, default="active")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_client_id: Mapped[str] = mapped_column(
        ForeignKey("client_credentials.id", ondelete="RESTRICT"),
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)

    members: Mapped[list[CollectionMember]] = relationship(
        back_populates="collection",
        cascade="all, delete-orphan",
        order_by="CollectionMember.position",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_collections_version"),
        CheckConstraint(
            "lifecycle_status IN ('active', 'archived')",
            name="ck_collections_lifecycle_status",
        ),
        Index("ix_collections_domain", "domain"),
        Index("ix_collections_deleted_at", "deleted_at"),
    )


class CollectionMember(Base):
    __tablename__ = "collection_members"

    collection_id: Mapped[str] = mapped_column(
        ForeignKey("collections.id", ondelete="CASCADE"),
        primary_key=True,
    )
    record_id: Mapped[str] = mapped_column(
        ForeignKey("records.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_candidate_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("candidate_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False
    )

    collection: Mapped[MemoryCollection] = relationship(back_populates="members")

    __table_args__ = (
        CheckConstraint(
            "position IS NULL OR position >= 0",
            name="ck_collection_members_position",
        ),
        Index("ix_collection_members_record", "record_id"),
        Index("ix_collection_members_source_item", "source_candidate_item_id"),
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
