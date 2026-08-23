"""Add immutable daily aggregate valuation snapshots.

Revision ID: 0004_daily_valuation_snapshots
Revises: 0003_mobile_connection
Create Date: 2026-08-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_daily_valuation_snapshots"
down_revision: str | None = "0003_mobile_connection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 historically called current metadata.create_all(). The guard keeps both
    # fresh installs and upgrades from an existing 0003 database safe.
    if inspector.has_table("daily_valuation_snapshots"):
        return

    op.create_table(
        "daily_valuation_snapshots",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("snapshot_date", sa.String(length=10), nullable=False),
        sa.Column("reporting_timezone", sa.String(length=64), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("base_currency", sa.String(length=3), nullable=False),
        sa.Column("quality", sa.String(length=32), nullable=False),
        sa.Column("provisional_net_worth", sa.Numeric(20, 6), nullable=False),
        sa.Column("known_net_worth", sa.Numeric(20, 6), nullable=False),
        sa.Column("non_investment_assets", sa.Numeric(20, 6), nullable=False),
        sa.Column("liquid_cash", sa.Numeric(20, 6), nullable=False),
        sa.Column("available_cash", sa.Numeric(20, 6), nullable=False),
        sa.Column("debt", sa.Numeric(20, 6), nullable=False),
        sa.Column("investment_book_value", sa.Numeric(20, 6), nullable=False),
        sa.Column("investment_market_value", sa.Numeric(20, 6), nullable=False),
        sa.Column("unpriced_investment_cost", sa.Numeric(20, 6), nullable=False),
        sa.Column("broker_market_value", sa.Numeric(20, 6), nullable=True),
        sa.Column("broker_position_count", sa.Integer(), nullable=False),
        sa.Column("price_as_of_min", sa.DateTime(timezone=True), nullable=True),
        sa.Column("price_as_of_max", sa.DateTime(timezone=True), nullable=True),
        sa.Column("missing_count", sa.Integer(), nullable=False),
        sa.Column("stale_count", sa.Integer(), nullable=False),
        sa.Column("broker_status", sa.String(length=32), nullable=False),
        sa.Column("warnings_json", sa.Text(), nullable=False),
        sa.Column("evidence_json", sa.Text(), nullable=False),
        sa.Column("calculation_version", sa.String(length=40), nullable=False),
        sa.Column("created_by", sa.String(length=80), nullable=False),
        sa.CheckConstraint(
            "missing_count >= 0",
            name="ck_daily_valuation_missing_nonnegative",
        ),
        sa.CheckConstraint(
            "stale_count >= 0",
            name="ck_daily_valuation_stale_nonnegative",
        ),
        sa.CheckConstraint(
            "broker_position_count >= 0",
            name="ck_daily_valuation_broker_positions_nonnegative",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_daily_valuation_snapshot_date",
        "daily_valuation_snapshots",
        ["snapshot_date"],
        unique=True,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("daily_valuation_snapshots"):
        return
    snapshot_count = int(
        bind.execute(sa.text("SELECT COUNT(*) FROM daily_valuation_snapshots")).scalar_one()
    )
    if snapshot_count:
        raise RuntimeError(
            "Refusing to downgrade 0004: daily valuation evidence exists; restore a verified "
            "0003 backup instead of discarding history."
        )
    op.drop_index(
        "uq_daily_valuation_snapshot_date",
        table_name="daily_valuation_snapshots",
    )
    op.drop_table("daily_valuation_snapshots")
