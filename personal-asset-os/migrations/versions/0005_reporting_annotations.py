"""Add audited transaction reporting annotations.

Revision ID: 0005_reporting_annotations
Revises: 0004_daily_valuation_snapshots
Create Date: 2026-08-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_reporting_annotations"
down_revision: str | None = "0004_daily_valuation_snapshots"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 historically called current metadata.create_all(). Keep fresh installs
    # and upgrades from an existing 0004 database equally safe.
    if inspector.has_table("transaction_reporting_annotations"):
        return

    op.create_table(
        "transaction_reporting_annotations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("transaction_id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=120), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("actor", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "version >= 1",
            name="ck_reporting_annotation_version_positive",
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_transaction_reporting_annotations_transaction_id",
        "transaction_reporting_annotations",
        ["transaction_id"],
        unique=True,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("transaction_reporting_annotations"):
        return
    annotation_count = int(
        bind.execute(
            sa.text("SELECT COUNT(*) FROM transaction_reporting_annotations")
        ).scalar_one()
    )
    if annotation_count:
        raise RuntimeError(
            "Refusing to downgrade 0005: reporting annotations exist; restore a verified "
            "0004 backup instead of discarding audit-backed metadata."
        )
    op.drop_index(
        "ix_transaction_reporting_annotations_transaction_id",
        table_name="transaction_reporting_annotations",
    )
    op.drop_table("transaction_reporting_annotations")
