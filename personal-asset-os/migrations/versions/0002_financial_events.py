"""Add durable Financial Event staging and finalize lineage.

Revision ID: 0002_financial_events
Revises: 0001_initial
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_financial_events"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _enum(*values: str, name: str) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=True)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 historically called current metadata.create_all(). The guards keep a fresh
    # install safe while still creating the tables when upgrading a deployed 0001 DB.
    if not inspector.has_table("financial_events"):
        op.create_table(
            "financial_events",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column(
                "event_kind",
                _enum("EXPENSE", "INCOME", "TRANSFER", "UNKNOWN", name="financialeventkind"),
                nullable=False,
            ),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("amount", sa.Numeric(20, 6), nullable=False),
            sa.Column("currency", sa.String(length=3), nullable=False),
            sa.Column("description", sa.String(length=240), nullable=False),
            sa.Column("merchant", sa.String(length=120), nullable=True),
            sa.Column("note", sa.String(length=500), nullable=True),
            sa.Column("category_hint", sa.String(length=120), nullable=True),
            sa.Column("payment_hint", sa.String(length=120), nullable=True),
            sa.Column("source", sa.String(length=40), nullable=False),
            sa.Column("source_reference", sa.String(length=120), nullable=True),
            sa.Column("device_id", sa.String(length=80), nullable=True),
            sa.Column("local_sequence", sa.Integer(), nullable=True),
            sa.Column(
                "status",
                _enum(
                    "PENDING_MATCH",
                    "NEEDS_REVIEW",
                    "MATCHED",
                    "REJECTED",
                    "SUPERSEDED",
                    name="financialeventstatus",
                ),
                nullable=False,
            ),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("idempotency_key", sa.String(length=120), nullable=False),
            sa.Column("ingest_payload_hash", sa.String(length=64), nullable=False),
            sa.Column("payload_hash", sa.String(length=64), nullable=False),
            sa.Column("finalization_hash", sa.String(length=64), nullable=True),
            sa.Column(
                "approval_source",
                _enum("LOCAL_UI", "PAIRED_MOBILE", name="approvalsource"),
                nullable=True,
            ),
            sa.Column("approved_by", sa.String(length=80), nullable=True),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("rejected_reason", sa.String(length=240), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.CheckConstraint("amount > 0", name="ck_financial_event_amount_positive"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("idempotency_key"),
        )
        op.create_index(
            "ix_financial_events_status_occurred",
            "financial_events",
            ["status", "occurred_at"],
            unique=False,
        )
        op.create_index(
            "ix_financial_events_device_sequence",
            "financial_events",
            ["device_id", "local_sequence"],
            unique=False,
        )

    inspector = sa.inspect(bind)
    if not inspector.has_table("financial_event_transaction_links"):
        op.create_table(
            "financial_event_transaction_links",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("event_id", sa.String(length=36), nullable=False),
            sa.Column("transaction_id", sa.String(length=36), nullable=False),
            sa.Column("relation_type", sa.String(length=24), nullable=False),
            sa.Column("allocated_amount", sa.Numeric(20, 6), nullable=False),
            sa.Column("currency", sa.String(length=3), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["event_id"], ["financial_events.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["transaction_id"], ["transactions.id"], ondelete="RESTRICT"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_financial_event_transaction_links_event_id",
            "financial_event_transaction_links",
            ["event_id"],
            unique=False,
        )
        op.create_index(
            "ix_financial_event_transaction_links_transaction_id",
            "financial_event_transaction_links",
            ["transaction_id"],
            unique=False,
        )
        op.create_index(
            "uq_financial_event_transaction_relation",
            "financial_event_transaction_links",
            ["event_id", "transaction_id", "relation_type"],
            unique=True,
        )

    audit_sql = bind.execute(
        sa.text("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_logs'")
    ).scalar_one_or_none()
    if audit_sql and "'UPDATE'" not in str(audit_sql):
        old_type = _enum("CREATE", "REVERSE", "BACKUP", "SNAPSHOT", name="auditaction")
        new_type = _enum(
            "CREATE",
            "UPDATE",
            "REJECT",
            "FINALIZE",
            "REVERSE",
            "BACKUP",
            "SNAPSHOT",
            name="auditaction",
        )
        with op.batch_alter_table("audit_logs", recreate="always") as batch_op:
            batch_op.alter_column(
                "action", existing_type=old_type, type_=new_type, existing_nullable=False
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("financial_events"):
        event_count = int(
            bind.execute(sa.text("SELECT COUNT(*) FROM financial_events")).scalar_one()
        )
        if event_count:
            raise RuntimeError(
                "Refusing to downgrade 0002: Financial Event data exists; restore a verified "
                "0001 backup instead of dropping staging lineage."
            )
    audit_sql = bind.execute(
        sa.text("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_logs'")
    ).scalar_one_or_none()
    if audit_sql and "'UPDATE'" in str(audit_sql):
        new_audit_count = int(
            bind.execute(
                sa.text(
                    "SELECT COUNT(*) FROM audit_logs "
                    "WHERE action IN ('UPDATE', 'REJECT', 'FINALIZE')"
                )
            ).scalar_one()
        )
        if new_audit_count:
            raise RuntimeError(
                "Refusing to downgrade 0002: v0.2 audit records exist; restore a verified "
                "0001 backup instead of discarding audit evidence."
            )
    if inspector.has_table("financial_event_transaction_links"):
        op.drop_table("financial_event_transaction_links")
    inspector = sa.inspect(bind)
    if inspector.has_table("financial_events"):
        op.drop_table("financial_events")

    if audit_sql and "'UPDATE'" in str(audit_sql):
        old_type = _enum(
            "CREATE",
            "UPDATE",
            "REJECT",
            "FINALIZE",
            "REVERSE",
            "BACKUP",
            "SNAPSHOT",
            name="auditaction",
        )
        new_type = _enum("CREATE", "REVERSE", "BACKUP", "SNAPSHOT", name="auditaction")
        with op.batch_alter_table("audit_logs", recreate="always") as batch_op:
            batch_op.alter_column(
                "action", existing_type=old_type, type_=new_type, existing_nullable=False
            )
