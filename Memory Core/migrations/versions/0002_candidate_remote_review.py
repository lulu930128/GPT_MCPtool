"""Add immutable candidate review and remote approval fields.

Revision ID: 0002_candidate_remote_review
Revises: 0001_initial_core
Create Date: 2026-07-24
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0002_candidate_remote_review"
down_revision: str | None = "0001_initial_core"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _json_value(value: Any, *, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, str):
        return json.loads(value)
    return value


def _review_digest(row: dict[str, Any]) -> str:
    envelope = {
        "version": 1,
        "operation": row["operation"],
        "target_type": row["target_type"],
        "target_id": row["target_id"],
        "base_version": row["base_version"],
        "proposed_content": _json_value(row["proposed_content"], fallback={}),
        "source_type": row["source_type"],
        "source_reference": row["source_reference"],
        "confidence": row["confidence"],
        "risk_flags": sorted(_json_value(row["risk_flags"], fallback=[])),
    }
    canonical = json.dumps(
        envelope,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:v1:" + hashlib.sha256(canonical).hexdigest()


def upgrade() -> None:
    op.add_column(
        "memory_candidates",
        sa.Column("review_digest", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column(
            "review_digest_version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("expires_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_prepared_by_client_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_challenge_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_challenge_expires_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_action", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_note", sa.Text(), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_idempotency_key", sa.String(length=160), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("review_request_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("result_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "memory_candidates",
        sa.Column("result_version", sa.Integer(), nullable=True),
    )

    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE memory_candidates
            SET result_id = target_id,
                target_id = NULL
            WHERE operation = 'create'
              AND status = 'applied'
              AND target_id IS NOT NULL
            """
        )
    )
    connection.execute(
        sa.text(
            """
            UPDATE memory_candidates
            SET result_id = target_id
            WHERE operation IN ('update', 'archive')
              AND status = 'applied'
              AND target_id IS NOT NULL
            """
        )
    )
    rows = connection.execute(
        sa.text(
            """
            SELECT id, operation, target_type, target_id, base_version,
                   proposed_content, source_type, source_reference, confidence, risk_flags,
                   status, result_id
            FROM memory_candidates
            """
        )
    ).mappings()
    for row_mapping in rows:
        row = dict(row_mapping)
        result_version = None
        if row["result_id"] and row["status"] == "applied":
            table_name = "records" if row["target_type"] == "record" else "entities"
            result_version = connection.scalar(
                sa.text(f"SELECT version FROM {table_name} WHERE id = :result_id"),
                {"result_id": row["result_id"]},
            )
        connection.execute(
            sa.text(
                """
                UPDATE memory_candidates
                SET review_digest = :review_digest,
                    expires_at = datetime(created_at, '+7 days'),
                    result_version = :result_version
                WHERE id = :candidate_id
                """
            ),
            {
                "candidate_id": row["id"],
                "review_digest": _review_digest(row),
                "result_version": result_version,
            },
        )

    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.alter_column(
            "review_digest",
            existing_type=sa.String(length=100),
            nullable=False,
        )
        batch_op.create_foreign_key(
            "fk_candidates_review_prepared_by_client",
            "client_credentials",
            ["review_prepared_by_client_id"],
            ["id"],
            ondelete="RESTRICT",
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
            "ck_candidates_status",
            "status IN ('pending', 'applied', 'rejected', 'conflict', 'expired')",
        )
        batch_op.create_check_constraint(
            "ck_candidates_target_shape",
            "(operation = 'create' AND target_id IS NULL AND base_version IS NULL) OR "
            "(operation IN ('update', 'archive') AND target_id IS NOT NULL "
            "AND base_version IS NOT NULL)",
        )
        batch_op.create_check_constraint(
            "ck_candidates_digest_version",
            "review_digest_version >= 1",
        )
        batch_op.create_check_constraint(
            "ck_candidates_result_version",
            "result_version IS NULL OR result_version >= 1",
        )
        batch_op.create_unique_constraint(
            "uq_candidate_review_idempotency",
            ["reviewed_by_client_id", "review_idempotency_key"],
        )
    op.create_index(
        "ix_memory_candidates_expires_at",
        "memory_candidates",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_memory_candidates_expires_at", table_name="memory_candidates")
    with op.batch_alter_table("memory_candidates", recreate="always") as batch_op:
        batch_op.drop_constraint("uq_candidate_review_idempotency", type_="unique")
        batch_op.drop_constraint("ck_candidates_result_version", type_="check")
        batch_op.drop_constraint("ck_candidates_digest_version", type_="check")
        batch_op.drop_constraint("ck_candidates_target_shape", type_="check")
        batch_op.drop_constraint("ck_candidates_status", type_="check")
        batch_op.drop_constraint("ck_candidates_target_type", type_="check")
        batch_op.drop_constraint("ck_candidates_operation", type_="check")
        batch_op.drop_constraint("fk_candidates_review_prepared_by_client", type_="foreignkey")
        batch_op.drop_column("result_version")
        batch_op.drop_column("result_id")
        batch_op.drop_column("review_request_hash")
        batch_op.drop_column("review_idempotency_key")
        batch_op.drop_column("review_note")
        batch_op.drop_column("review_action")
        batch_op.drop_column("review_challenge_expires_at")
        batch_op.drop_column("review_challenge_hash")
        batch_op.drop_column("review_prepared_by_client_id")
        batch_op.drop_column("expires_at")
        batch_op.drop_column("review_digest_version")
        batch_op.drop_column("review_digest")
