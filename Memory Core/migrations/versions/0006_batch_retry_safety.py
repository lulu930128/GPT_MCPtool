"""separate batch execution errors and retry policy

Revision ID: 0006_batch_retry_safety
Revises: 0005_batch_item_collections
Create Date: 2026-07-29
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_batch_retry_safety"
down_revision = "0005_batch_item_collections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("candidate_items", recreate="always") as batch_op:
        batch_op.add_column(sa.Column("execution_error_code", sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column("execution_error_message", sa.Text(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "retry_policy",
                sa.String(length=30),
                nullable=False,
                server_default="not_applicable",
            )
        )
        batch_op.create_check_constraint(
            "ck_candidate_items_retry_policy",
            "retry_policy IN ("
            "'not_applicable', 'retry_same_plan', 'verify_only', 'new_batch_required'"
            ")",
        )

    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE candidate_items
            SET execution_error_code = error_code,
                execution_error_message = error_message,
                error_code = NULL,
                error_message = NULL,
                retry_policy = CASE
                    WHEN execution_state = 'unverified' THEN 'verify_only'
                    WHEN execution_state = 'failed' THEN 'new_batch_required'
                    ELSE 'not_applicable'
                END
            WHERE execution_state IN ('failed', 'unverified')
            """
        )
    )
    unsupported_count = connection.scalar(
        sa.text(
            """
            SELECT COUNT(*)
            FROM batch_item_operations
            WHERE change_type NOT IN (
                'record_create', 'record_update',
                'entity_create', 'entity_update',
                'record_entity_link_upsert', 'collection_member_upsert'
            )
            """
        )
    )
    if unsupported_count:
        raise RuntimeError(
            "Cannot tighten Batch operation policy while unsupported operations exist."
        )
    with op.batch_alter_table("batch_item_operations", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_batch_item_operations_change_type", type_="check")
        batch_op.create_check_constraint(
            "ck_batch_item_operations_change_type",
            "change_type IN ("
            "'record_create', 'record_update', "
            "'entity_create', 'entity_update', "
            "'record_entity_link_upsert', 'collection_member_upsert'"
            ")",
        )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE candidate_items
            SET error_code = COALESCE(error_code, execution_error_code),
                error_message = COALESCE(error_message, execution_error_message)
            WHERE execution_error_code IS NOT NULL
               OR execution_error_message IS NOT NULL
            """
        )
    )
    with op.batch_alter_table("candidate_items", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_candidate_items_retry_policy", type_="check")
        batch_op.drop_column("retry_policy")
        batch_op.drop_column("execution_error_message")
        batch_op.drop_column("execution_error_code")
    with op.batch_alter_table("batch_item_operations", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_batch_item_operations_change_type", type_="check")
        batch_op.create_check_constraint(
            "ck_batch_item_operations_change_type",
            "change_type IN ("
            "'record_create', 'record_update', 'record_archive', "
            "'entity_create', 'entity_update', 'entity_archive', "
            "'record_entity_link_upsert', 'record_link_upsert', "
            "'entity_relation_upsert', 'collection_member_upsert'"
            ")",
        )
