"""Add paired mobile device identity and ingest uniqueness.

Revision ID: 0003_mobile_connection
Revises: 0002_financial_events
Create Date: 2026-08-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_mobile_connection"
down_revision: str | None = "0002_financial_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _index_is_unique(inspector: sa.Inspector, table_name: str, index_name: str) -> bool | None:
    for index in inspector.get_indexes(table_name):
        if index["name"] == index_name:
            return bool(index.get("unique"))
    return None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 historically called current metadata.create_all(); guards are required for
    # both fresh installs and upgrades from an already deployed 0002 database.
    if not inspector.has_table("mobile_devices"):
        op.create_table(
            "mobile_devices",
            sa.Column("id", sa.String(length=80), nullable=False),
            sa.Column("display_name", sa.String(length=120), nullable=False),
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("paired_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_accepted_sequence", sa.Integer(), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "last_accepted_sequence >= 0",
                name="ck_mobile_device_last_sequence_nonnegative",
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token_hash"),
        )

    inspector = sa.inspect(bind)
    if not inspector.has_table("mobile_pairing_sessions"):
        op.create_table(
            "mobile_pairing_sessions",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("code_hash", sa.String(length=64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("paired_device_id", sa.String(length=80), nullable=True),
            sa.ForeignKeyConstraint(
                ["paired_device_id"], ["mobile_devices.id"], ondelete="RESTRICT"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("code_hash"),
        )
        op.create_index(
            "ix_mobile_pairing_sessions_expires",
            "mobile_pairing_sessions",
            ["expires_at"],
            unique=False,
        )

    inspector = sa.inspect(bind)
    uniqueness = _index_is_unique(
        inspector, "financial_events", "ix_financial_events_device_sequence"
    )
    if uniqueness is False:
        duplicate = bind.execute(
            sa.text(
                "SELECT device_id, local_sequence, COUNT(*) AS count "
                "FROM financial_events "
                "WHERE device_id IS NOT NULL AND local_sequence IS NOT NULL "
                "GROUP BY device_id, local_sequence HAVING COUNT(*) > 1 LIMIT 1"
            )
        ).first()
        if duplicate is not None:
            raise RuntimeError(
                "Refusing to upgrade 0003: duplicate mobile device sequence exists; "
                "reconcile the conflicting Financial Events first."
            )
        op.drop_index("ix_financial_events_device_sequence", table_name="financial_events")
        op.create_index(
            "ix_financial_events_device_sequence",
            "financial_events",
            ["device_id", "local_sequence"],
            unique=True,
        )
    elif uniqueness is None:
        op.create_index(
            "ix_financial_events_device_sequence",
            "financial_events",
            ["device_id", "local_sequence"],
            unique=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("mobile_devices"):
        device_count = int(
            bind.execute(sa.text("SELECT COUNT(*) FROM mobile_devices")).scalar_one()
        )
        if device_count:
            raise RuntimeError(
                "Refusing to downgrade 0003: paired device credentials exist; revoke and "
                "remove them through an explicit recovery workflow first."
            )
    if inspector.has_table("mobile_pairing_sessions"):
        pairing_count = int(
            bind.execute(sa.text("SELECT COUNT(*) FROM mobile_pairing_sessions")).scalar_one()
        )
        if pairing_count:
            raise RuntimeError(
                "Refusing to downgrade 0003: pairing audit state exists; restore a verified "
                "0002 backup instead of discarding it."
            )
    if inspector.has_table("financial_events"):
        mobile_event_count = int(
            bind.execute(
                sa.text("SELECT COUNT(*) FROM financial_events WHERE source = 'mobile_sync'")
            ).scalar_one()
        )
        if mobile_event_count:
            raise RuntimeError(
                "Refusing to downgrade 0003: mobile Financial Events exist; restore a verified "
                "0002 backup instead of weakening ingest uniqueness."
            )

    uniqueness = _index_is_unique(
        inspector, "financial_events", "ix_financial_events_device_sequence"
    )
    if uniqueness is True:
        op.drop_index("ix_financial_events_device_sequence", table_name="financial_events")
        op.create_index(
            "ix_financial_events_device_sequence",
            "financial_events",
            ["device_id", "local_sequence"],
            unique=False,
        )
    if inspector.has_table("mobile_pairing_sessions"):
        op.drop_table("mobile_pairing_sessions")
    inspector = sa.inspect(bind)
    if inspector.has_table("mobile_devices"):
        op.drop_table("mobile_devices")
