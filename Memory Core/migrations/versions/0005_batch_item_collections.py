"""Add Batch, Item, apply-attempt, and Collection persistence.

Revision ID: 0005_batch_item_collections
Revises: 0004_record_link_projection
Create Date: 2026-07-29
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_batch_item_collections"
down_revision: str | None = "0004_record_link_projection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _create_batch_tables() -> None:
    op.create_table(
        "candidate_batches",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("candidate_id", sa.String(length=36), nullable=False),
        sa.Column("profile_id", sa.String(length=160), nullable=False),
        sa.Column("profile_version", sa.Integer(), nullable=False),
        sa.Column("profile_hash", sa.String(length=100), nullable=False),
        sa.Column("normalizer_version", sa.String(length=40), nullable=False),
        sa.Column("input_hash", sa.String(length=100), nullable=False),
        sa.Column("current_revision_no", sa.Integer(), nullable=False),
        sa.Column("plan_state", sa.String(length=20), nullable=False),
        sa.Column("review_state", sa.String(length=20), nullable=False),
        sa.Column("execution_state", sa.String(length=30), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "profile_version >= 1",
            name="ck_candidate_batches_profile_version",
        ),
        sa.CheckConstraint(
            "current_revision_no >= 1",
            name="ck_candidate_batches_current_revision",
        ),
        sa.CheckConstraint("item_count >= 0", name="ck_candidate_batches_item_count"),
        sa.CheckConstraint(
            "plan_state IN ('draft', 'blocked', 'ready', 'sealed')",
            name="ck_candidate_batches_plan_state",
        ),
        sa.CheckConstraint(
            "review_state IN ('pending', 'prepared', 'approved', 'rejected', 'expired')",
            name="ck_candidate_batches_review_state",
        ),
        sa.CheckConstraint(
            "execution_state IN ("
            "'not_started', 'applying', 'applied', 'partially_applied', 'failed'"
            ")",
            name="ck_candidate_batches_execution_state",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_id"],
            ["memory_candidates.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("candidate_id", name="uq_candidate_batches_candidate_id"),
    )
    op.create_index(
        "ix_candidate_batches_candidate",
        "candidate_batches",
        ["candidate_id"],
    )
    op.create_index(
        "ix_candidate_batches_profile",
        "candidate_batches",
        ["profile_id", "profile_version"],
    )
    op.create_index(
        "ix_candidate_batches_states",
        "candidate_batches",
        ["plan_state", "review_state", "execution_state"],
    )

    op.create_table(
        "candidate_batch_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("batch_id", sa.String(length=36), nullable=False),
        sa.Column("revision_no", sa.Integer(), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("input_hash", sa.String(length=100), nullable=False),
        sa.Column("plan_snapshot", sa.JSON(), nullable=False),
        sa.Column("plan_hash", sa.String(length=100), nullable=False),
        sa.Column("review_digest", sa.String(length=100), nullable=True),
        sa.Column("sealed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "revision_no >= 1",
            name="ck_candidate_batch_revisions_number",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["candidate_batches.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "batch_id",
            "revision_no",
            name="uq_candidate_batch_revision_number",
        ),
    )
    op.create_index(
        "ix_candidate_batch_revisions_batch",
        "candidate_batch_revisions",
        ["batch_id"],
    )

    op.create_table(
        "candidate_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("batch_id", sa.String(length=36), nullable=False),
        sa.Column("batch_revision_id", sa.String(length=36), nullable=False),
        sa.Column("unit_key", sa.String(length=200), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("source_index", sa.Integer(), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("normalized_snapshot", sa.JSON(), nullable=False),
        sa.Column("input_hash", sa.String(length=100), nullable=False),
        sa.Column("plan_hash", sa.String(length=100), nullable=False),
        sa.Column("decision", sa.String(length=20), nullable=False),
        sa.Column("execution_state", sa.String(length=20), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("claim_token", sa.String(length=100), nullable=True),
        sa.Column("claim_expires_at", sa.DateTime(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("applied_at", sa.DateTime(), nullable=True),
        sa.Column("verified_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("position >= 0", name="ck_candidate_items_position"),
        sa.CheckConstraint("source_index >= 0", name="ck_candidate_items_source_index"),
        sa.CheckConstraint("attempt_count >= 0", name="ck_candidate_items_attempt_count"),
        sa.CheckConstraint(
            "decision IN ('create', 'update', 'noop', 'conflict', 'invalid', 'excluded')",
            name="ck_candidate_items_decision",
        ),
        sa.CheckConstraint(
            "execution_state IN ("
            "'not_started', 'claimed', 'applied', 'failed', 'unverified', 'skipped'"
            ")",
            name="ck_candidate_items_execution_state",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["candidate_batches.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["batch_revision_id"],
            ["candidate_batch_revisions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "batch_revision_id",
            "position",
            name="uq_candidate_item_position",
        ),
    )
    op.create_index(
        "ix_candidate_items_batch",
        "candidate_items",
        ["batch_id", "position"],
    )
    op.create_index(
        "ix_candidate_items_revision",
        "candidate_items",
        ["batch_revision_id", "position"],
    )
    op.create_index(
        "ix_candidate_items_unit_key",
        "candidate_items",
        ["batch_revision_id", "unit_key"],
    )
    op.create_index(
        "ix_candidate_items_state",
        "candidate_items",
        ["batch_id", "execution_state"],
    )

    op.create_table(
        "batch_item_operations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("candidate_item_id", sa.String(length=36), nullable=False),
        sa.Column("op_id", sa.String(length=64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("change_type", sa.String(length=40), nullable=False),
        sa.Column("change_data", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_batch_item_operations_position",
        ),
        sa.CheckConstraint(
            "change_type IN ("
            "'record_create', 'record_update', 'record_archive', "
            "'entity_create', 'entity_update', 'entity_archive', "
            "'record_entity_link_upsert', 'record_link_upsert', "
            "'entity_relation_upsert', 'collection_member_upsert'"
            ")",
            name="ck_batch_item_operations_change_type",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_item_id"],
            ["candidate_items.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "candidate_item_id",
            "op_id",
            name="uq_batch_item_operation_op_id",
        ),
        sa.UniqueConstraint(
            "candidate_item_id",
            "position",
            name="uq_batch_item_operation_position",
        ),
    )
    op.create_index(
        "ix_batch_item_operations_item",
        "batch_item_operations",
        ["candidate_item_id", "position"],
    )

    op.create_table(
        "batch_item_results",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("candidate_item_id", sa.String(length=36), nullable=False),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("op_id", sa.String(length=64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("operation_outcome", sa.String(length=20), nullable=False),
        sa.Column("result_kind", sa.String(length=40), nullable=False),
        sa.Column("result_ref", sa.String(length=200), nullable=True),
        sa.Column("result_locator", sa.JSON(), nullable=False),
        sa.Column("result_version", sa.Integer(), nullable=True),
        sa.Column("verify_status", sa.String(length=20), nullable=False),
        sa.Column("verify_error_code", sa.String(length=80), nullable=True),
        sa.Column("verified_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_batch_item_results_position",
        ),
        sa.CheckConstraint(
            "operation_outcome IN ('created', 'updated', 'archived', 'noop')",
            name="ck_batch_item_results_outcome",
        ),
        sa.CheckConstraint(
            "result_kind IN ("
            "'record', 'entity', 'record_entity_link', 'record_link', "
            "'entity_relation', 'collection_member'"
            ")",
            name="ck_batch_item_results_kind",
        ),
        sa.CheckConstraint(
            "result_version IS NULL OR result_version >= 1",
            name="ck_batch_item_results_version",
        ),
        sa.CheckConstraint(
            "verify_status IN ('pending', 'verified', 'failed', 'not_applicable')",
            name="ck_batch_item_results_verify_status",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_item_id"],
            ["candidate_items.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["batch_item_operations.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "candidate_item_id",
            "op_id",
            name="uq_batch_item_result_op_id",
        ),
        sa.UniqueConstraint(
            "operation_id",
            name="uq_batch_item_result_operation",
        ),
    )
    op.create_index(
        "ix_batch_item_results_item",
        "batch_item_results",
        ["candidate_item_id", "position"],
    )

    op.create_table(
        "batch_apply_attempts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("batch_id", sa.String(length=36), nullable=False),
        sa.Column("batch_revision_id", sa.String(length=36), nullable=False),
        sa.Column("reviewer_client_id", sa.String(length=36), nullable=False),
        sa.Column("approval_idempotency_key", sa.String(length=160), nullable=False),
        sa.Column("approval_request_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("lease_token", sa.String(length=100), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "status IN ('running', 'completed', 'interrupted', 'failed')",
            name="ck_batch_apply_attempts_status",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["candidate_batches.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["batch_revision_id"],
            ["candidate_batch_revisions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reviewer_client_id"],
            ["client_credentials.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "reviewer_client_id",
            "approval_idempotency_key",
            name="uq_batch_apply_attempt_idempotency",
        ),
    )
    op.create_index(
        "ix_batch_apply_attempts_batch",
        "batch_apply_attempts",
        ["batch_id", "created_at"],
    )
    op.create_index(
        "ix_batch_apply_attempts_lease",
        "batch_apply_attempts",
        ["status", "lease_expires_at"],
    )


def _create_collection_tables() -> None:
    op.create_table(
        "collections",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("key", sa.String(length=160), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("domain", sa.String(length=80), nullable=True),
        sa.Column("lifecycle_status", sa.String(length=30), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_by_client_id", sa.String(length=36), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("version >= 1", name="ck_collections_version"),
        sa.CheckConstraint(
            "lifecycle_status IN ('active', 'archived')",
            name="ck_collections_lifecycle_status",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_client_id"],
            ["client_credentials.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key", name="uq_collections_key"),
    )
    op.create_index("ix_collections_domain", "collections", ["domain"])
    op.create_index("ix_collections_deleted_at", "collections", ["deleted_at"])

    op.create_table(
        "collection_members",
        sa.Column("collection_id", sa.String(length=36), nullable=False),
        sa.Column("record_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=True),
        sa.Column("source_candidate_item_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "position IS NULL OR position >= 0",
            name="ck_collection_members_position",
        ),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["collections.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_candidate_item_id"],
            ["candidate_items.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("collection_id", "record_id"),
    )
    op.create_index(
        "ix_collection_members_record",
        "collection_members",
        ["record_id"],
    )
    op.create_index(
        "ix_collection_members_source_item",
        "collection_members",
        ["source_candidate_item_id"],
    )


def upgrade() -> None:
    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_candidates_target_shape", type_="check")
        batch_op.drop_constraint("ck_candidates_target_type", type_="check")
        batch_op.drop_constraint("ck_candidates_operation", type_="check")
        batch_op.drop_constraint("ck_candidates_kind", type_="check")
        batch_op.create_check_constraint(
            "ck_candidates_kind",
            "candidate_kind IN ('single', 'change_set', 'batch')",
        )
        batch_op.create_check_constraint(
            "ck_candidates_operation",
            "(candidate_kind = 'single' AND operation IN ('create', 'update', 'archive')) OR "
            "(candidate_kind IN ('change_set', 'batch') AND operation IS NULL)",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_type",
            "(candidate_kind = 'single' AND target_type IN ('record', 'entity')) OR "
            "(candidate_kind IN ('change_set', 'batch') AND target_type IS NULL)",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_shape",
            "(candidate_kind = 'single' AND ("
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL))) OR "
            "(candidate_kind IN ('change_set', 'batch') "
            "AND target_id IS NULL AND base_version IS NULL)",
        )

    _create_batch_tables()
    _create_collection_tables()


def downgrade() -> None:
    connection = op.get_bind()
    batch_count = connection.scalar(
        sa.text("SELECT COUNT(*) FROM memory_candidates WHERE candidate_kind = 'batch'")
    )
    collection_count = connection.scalar(sa.text("SELECT COUNT(*) FROM collections"))
    if batch_count or collection_count:
        raise RuntimeError(
            "Cannot downgrade while Batch candidates or Collections exist; "
            "export or remove them first."
        )

    op.drop_index("ix_collection_members_source_item", table_name="collection_members")
    op.drop_index("ix_collection_members_record", table_name="collection_members")
    op.drop_table("collection_members")
    op.drop_index("ix_collections_deleted_at", table_name="collections")
    op.drop_index("ix_collections_domain", table_name="collections")
    op.drop_table("collections")

    op.drop_index("ix_batch_apply_attempts_lease", table_name="batch_apply_attempts")
    op.drop_index("ix_batch_apply_attempts_batch", table_name="batch_apply_attempts")
    op.drop_table("batch_apply_attempts")
    op.drop_index("ix_batch_item_results_item", table_name="batch_item_results")
    op.drop_table("batch_item_results")
    op.drop_index("ix_batch_item_operations_item", table_name="batch_item_operations")
    op.drop_table("batch_item_operations")
    op.drop_index("ix_candidate_items_state", table_name="candidate_items")
    op.drop_index("ix_candidate_items_unit_key", table_name="candidate_items")
    op.drop_index("ix_candidate_items_revision", table_name="candidate_items")
    op.drop_index("ix_candidate_items_batch", table_name="candidate_items")
    op.drop_table("candidate_items")
    op.drop_index(
        "ix_candidate_batch_revisions_batch",
        table_name="candidate_batch_revisions",
    )
    op.drop_table("candidate_batch_revisions")
    op.drop_index("ix_candidate_batches_states", table_name="candidate_batches")
    op.drop_index("ix_candidate_batches_profile", table_name="candidate_batches")
    op.drop_index("ix_candidate_batches_candidate", table_name="candidate_batches")
    op.drop_table("candidate_batches")

    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_candidates_target_shape", type_="check")
        batch_op.drop_constraint("ck_candidates_target_type", type_="check")
        batch_op.drop_constraint("ck_candidates_operation", type_="check")
        batch_op.drop_constraint("ck_candidates_kind", type_="check")
        batch_op.create_check_constraint(
            "ck_candidates_kind",
            "candidate_kind IN ('single', 'change_set')",
        )
        batch_op.create_check_constraint(
            "ck_candidates_operation",
            "(candidate_kind = 'single' AND operation IN ('create', 'update', 'archive')) OR "
            "(candidate_kind = 'change_set' AND operation IS NULL)",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_type",
            "(candidate_kind = 'single' AND target_type IN ('record', 'entity')) OR "
            "(candidate_kind = 'change_set' AND target_type IS NULL)",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_shape",
            "(candidate_kind = 'single' AND ("
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL))) OR "
            "(candidate_kind = 'change_set' AND target_id IS NULL AND base_version IS NULL)",
        )
