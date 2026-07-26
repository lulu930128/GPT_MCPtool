"""Create the Memory Core v1 schema.

Revision ID: 0001_initial_core
Revises:
Create Date: 2026-07-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial_core"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "client_credentials",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_table(
        "records",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("domain", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("body_markdown", sa.Text(), nullable=True),
        sa.Column("occurred_start", sa.DateTime(), nullable=True),
        sa.Column("occurred_end", sa.DateTime(), nullable=True),
        sa.Column("date_precision", sa.String(length=20), nullable=False),
        sa.Column("timezone_name", sa.String(length=80), nullable=True),
        sa.Column("importance", sa.Integer(), nullable=False),
        sa.Column("lifecycle_status", sa.String(length=30), nullable=False),
        sa.Column("verification_status", sa.String(length=30), nullable=False),
        sa.Column("sensitivity", sa.String(length=30), nullable=False),
        sa.Column("handling_policy", sa.String(length=40), nullable=False),
        sa.Column("schema_name", sa.String(length=100), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("source_type", sa.String(length=40), nullable=False),
        sa.Column("source_reference", sa.Text(), nullable=True),
        sa.Column("supersedes_id", sa.String(length=36), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_by_client_id", sa.String(length=36), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["supersedes_id"], ["records.id"], ondelete="SET NULL"),
        sa.CheckConstraint("importance >= 0 AND importance <= 100", name="ck_records_importance"),
        sa.CheckConstraint("version >= 1", name="ck_records_version"),
        sa.CheckConstraint("schema_version >= 1", name="ck_records_schema_version"),
        sa.CheckConstraint(
            "handling_policy != 'company_restricted' OR sensitivity = 'restricted'",
            name="ck_records_company_restricted",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_records_kind", "records", ["kind"])
    op.create_index("ix_records_domain", "records", ["domain"])
    op.create_index("ix_records_sensitivity", "records", ["sensitivity"])
    op.create_index("ix_records_occurred_start", "records", ["occurred_start"])
    op.create_index("ix_records_deleted_at", "records", ["deleted_at"])

    op.create_table(
        "entities",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("entity_type", sa.String(length=60), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("canonical_name", sa.String(length=300), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("sensitivity", sa.String(length=30), nullable=False),
        sa.Column("handling_policy", sa.String(length=40), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_by_client_id", sa.String(length=36), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.CheckConstraint("version >= 1", name="ck_entities_version"),
        sa.CheckConstraint(
            "handling_policy != 'company_restricted' OR sensitivity = 'restricted'",
            name="ck_entities_company_restricted",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_entities_type", "entities", ["entity_type"])
    op.create_index("ix_entities_name", "entities", ["name"])
    op.create_index("ix_entities_sensitivity", "entities", ["sensitivity"])
    op.create_index("ix_entities_deleted_at", "entities", ["deleted_at"])

    op.create_table(
        "tags",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("category", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "record_entities",
        sa.Column("record_id", sa.String(length=36), nullable=False),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["record_id"], ["records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id", "entity_id", "role"),
    )
    op.create_table(
        "record_tags",
        sa.Column("record_id", sa.String(length=36), nullable=False),
        sa.Column("tag_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id", "tag_id"),
    )
    op.create_table(
        "entity_relations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("subject_entity_id", sa.String(length=36), nullable=False),
        sa.Column("predicate", sa.String(length=120), nullable=False),
        sa.Column("object_entity_id", sa.String(length=36), nullable=False),
        sa.Column("valid_from", sa.DateTime(), nullable=True),
        sa.Column("valid_to", sa.DateTime(), nullable=True),
        sa.Column("source_record_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["object_entity_id"], ["entities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_record_id"], ["records.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["subject_entity_id"], ["entities.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "subject_entity_id", "predicate", "object_entity_id", name="uq_entity_relation"
        ),
    )
    op.create_table(
        "record_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("subject_record_id", sa.String(length=36), nullable=False),
        sa.Column("relation", sa.String(length=120), nullable=False),
        sa.Column("object_record_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["object_record_id"], ["records.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["subject_record_id"], ["records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "subject_record_id", "relation", "object_record_id", name="uq_record_link"
        ),
    )
    op.create_table(
        "memory_candidates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("operation", sa.String(length=20), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=True),
        sa.Column("base_version", sa.Integer(), nullable=True),
        sa.Column("proposed_content", sa.JSON(), nullable=False),
        sa.Column("source_type", sa.String(length=40), nullable=False),
        sa.Column("source_reference", sa.Text(), nullable=True),
        sa.Column("source_client_id", sa.String(length=36), nullable=False),
        sa.Column("idempotency_key", sa.String(length=160), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("validation_result", sa.JSON(), nullable=False),
        sa.Column("risk_flags", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by_client_id", sa.String(length=36), nullable=True),
        sa.ForeignKeyConstraint(
            ["reviewed_by_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["source_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_candidates_confidence",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_client_id", "idempotency_key", name="uq_candidate_idempotency"),
    )
    op.create_index("ix_memory_candidates_status", "memory_candidates", ["status"])
    op.create_index(
        "ix_memory_candidates_target", "memory_candidates", ["target_type", "target_id"]
    )
    op.create_table(
        "revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("target_type", sa.String(length=30), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("revision_no", sa.Integer(), nullable=False),
        sa.Column("old_data", sa.JSON(), nullable=True),
        sa.Column("new_data", sa.JSON(), nullable=True),
        sa.Column("changed_by_client_id", sa.String(length=36), nullable=False),
        sa.Column("change_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["changed_by_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_type", "target_id", "revision_no", name="uq_revision_no"),
    )
    op.create_index("ix_revisions_target", "revisions", ["target_type", "target_id"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("client_id", sa.String(length=36), nullable=True),
        sa.Column("action", sa.String(length=120), nullable=False),
        sa.Column("target_type", sa.String(length=30), nullable=True),
        sa.Column("target_id", sa.String(length=36), nullable=True),
        sa.Column("outcome", sa.String(length=30), nullable=False),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["client_credentials.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_target", "audit_events", ["target_type", "target_id"])
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("record_id", sa.String(length=36), nullable=False),
        sa.Column("original_filename", sa.String(length=500), nullable=False),
        sa.Column("stored_path", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.String(length=200), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("sensitivity", sa.String(length=30), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["records.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_attachments_content_hash", "attachments", ["content_hash"])
    op.create_table(
        "export_manifests",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("operation_type", sa.String(length=30), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("created_by_client_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_client_id"], ["client_credentials.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.execute(
        """
        CREATE VIRTUAL TABLE records_fts USING fts5(
            title,
            summary,
            body_markdown,
            content='records',
            content_rowid='rowid',
            tokenize='trigram'
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER records_fts_insert AFTER INSERT ON records BEGIN
            INSERT INTO records_fts(rowid, title, summary, body_markdown)
            VALUES (
                new.rowid,
                new.title,
                coalesce(new.summary, ''),
                coalesce(new.body_markdown, '')
            );
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER records_fts_delete AFTER DELETE ON records BEGIN
            INSERT INTO records_fts(records_fts, rowid, title, summary, body_markdown)
            VALUES (
                'delete',
                old.rowid,
                old.title,
                coalesce(old.summary, ''),
                coalesce(old.body_markdown, '')
            );
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER records_fts_update AFTER UPDATE ON records BEGIN
            INSERT INTO records_fts(records_fts, rowid, title, summary, body_markdown)
            VALUES (
                'delete',
                old.rowid,
                old.title,
                coalesce(old.summary, ''),
                coalesce(old.body_markdown, '')
            );
            INSERT INTO records_fts(rowid, title, summary, body_markdown)
            VALUES (
                new.rowid,
                new.title,
                coalesce(new.summary, ''),
                coalesce(new.body_markdown, '')
            );
        END
        """
    )
    op.execute("INSERT INTO records_fts(records_fts) VALUES ('rebuild')")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS records_fts_update")
    op.execute("DROP TRIGGER IF EXISTS records_fts_delete")
    op.execute("DROP TRIGGER IF EXISTS records_fts_insert")
    op.execute("DROP TABLE IF EXISTS records_fts")
    op.drop_table("export_manifests")
    op.drop_index("ix_attachments_content_hash", table_name="attachments")
    op.drop_table("attachments")
    op.drop_index("ix_audit_events_target", table_name="audit_events")
    op.drop_index("ix_audit_events_created_at", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_revisions_target", table_name="revisions")
    op.drop_table("revisions")
    op.drop_index("ix_memory_candidates_target", table_name="memory_candidates")
    op.drop_index("ix_memory_candidates_status", table_name="memory_candidates")
    op.drop_table("memory_candidates")
    op.drop_table("record_links")
    op.drop_table("entity_relations")
    op.drop_table("record_tags")
    op.drop_table("record_entities")
    op.drop_table("tags")
    op.drop_index("ix_entities_deleted_at", table_name="entities")
    op.drop_index("ix_entities_sensitivity", table_name="entities")
    op.drop_index("ix_entities_name", table_name="entities")
    op.drop_index("ix_entities_type", table_name="entities")
    op.drop_table("entities")
    op.drop_index("ix_records_deleted_at", table_name="records")
    op.drop_index("ix_records_occurred_start", table_name="records")
    op.drop_index("ix_records_sensitivity", table_name="records")
    op.drop_index("ix_records_domain", table_name="records")
    op.drop_index("ix_records_kind", table_name="records")
    op.drop_table("records")
    op.drop_table("client_credentials")
