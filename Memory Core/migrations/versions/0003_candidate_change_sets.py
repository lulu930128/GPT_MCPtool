"""Add multi-operation candidate ChangeSets.

Revision ID: 0003_candidate_change_sets
Revises: 0002_candidate_remote_review
Create Date: 2026-07-27
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_candidate_change_sets"
down_revision: str | None = "0002_candidate_remote_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "memory_candidates",
        sa.Column(
            "candidate_kind",
            sa.String(length=20),
            nullable=False,
            server_default=sa.text("'single'"),
        ),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("summary", sa.String(length=500), nullable=True),
    )

    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_candidates_target_shape", type_="check")
        batch_op.drop_constraint("ck_candidates_target_type", type_="check")
        batch_op.drop_constraint("ck_candidates_operation", type_="check")
        batch_op.alter_column(
            "operation",
            existing_type=sa.String(length=20),
            nullable=True,
        )
        batch_op.alter_column(
            "target_type",
            existing_type=sa.String(length=20),
            nullable=True,
        )
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

    op.create_table(
        "candidate_operations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("candidate_id", sa.String(length=36), nullable=False),
        sa.Column("op_id", sa.String(length=64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("change_type", sa.String(length=40), nullable=False),
        sa.Column("change_data", sa.JSON(), nullable=False),
        sa.CheckConstraint("position >= 0", name="ck_candidate_operations_position"),
        sa.CheckConstraint(
            "change_type IN ('record_create', 'record_update')",
            name="ck_candidate_operations_change_type",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_id"],
            ["memory_candidates.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "candidate_id",
            "op_id",
            name="uq_candidate_operation_op_id",
        ),
        sa.UniqueConstraint(
            "candidate_id",
            "position",
            name="uq_candidate_operation_position",
        ),
    )
    op.create_index(
        "ix_candidate_operations_candidate",
        "candidate_operations",
        ["candidate_id"],
    )

    op.create_table(
        "candidate_results",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("candidate_id", sa.String(length=36), nullable=False),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("op_id", sa.String(length=64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("change_type", sa.String(length=40), nullable=False),
        sa.Column("result_type", sa.String(length=20), nullable=False),
        sa.Column("result_id", sa.String(length=36), nullable=False),
        sa.Column("result_version", sa.Integer(), nullable=False),
        sa.CheckConstraint("position >= 0", name="ck_candidate_results_position"),
        sa.CheckConstraint(
            "result_type IN ('record', 'entity')",
            name="ck_candidate_results_type",
        ),
        sa.CheckConstraint("result_version >= 1", name="ck_candidate_results_version"),
        sa.ForeignKeyConstraint(
            ["candidate_id"],
            ["memory_candidates.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["candidate_operations.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "candidate_id",
            "op_id",
            name="uq_candidate_result_op_id",
        ),
        sa.UniqueConstraint("operation_id", name="uq_candidate_result_operation"),
    )
    op.create_index(
        "ix_candidate_results_candidate",
        "candidate_results",
        ["candidate_id"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    change_set_count = connection.scalar(
        sa.text("SELECT COUNT(*) FROM memory_candidates WHERE candidate_kind = 'change_set'")
    )
    if change_set_count:
        raise RuntimeError(
            "Cannot downgrade while ChangeSet candidates exist; export or remove them first."
        )

    op.drop_index("ix_candidate_results_candidate", table_name="candidate_results")
    op.drop_table("candidate_results")
    op.drop_index("ix_candidate_operations_candidate", table_name="candidate_operations")
    op.drop_table("candidate_operations")

    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_candidates_target_shape", type_="check")
        batch_op.drop_constraint("ck_candidates_target_type", type_="check")
        batch_op.drop_constraint("ck_candidates_operation", type_="check")
        batch_op.drop_constraint("ck_candidates_kind", type_="check")
        batch_op.alter_column(
            "operation",
            existing_type=sa.String(length=20),
            nullable=False,
        )
        batch_op.alter_column(
            "target_type",
            existing_type=sa.String(length=20),
            nullable=False,
        )
        batch_op.create_check_constraint(
            "ck_candidates_operation",
            "operation IN ('create', 'update', 'archive')",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_type",
            "target_type IN ('record', 'entity')",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_shape",
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL)",
        )
        batch_op.drop_column("summary")
        batch_op.drop_column("candidate_kind")
