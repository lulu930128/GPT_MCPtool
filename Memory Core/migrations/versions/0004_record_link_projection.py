"""Add revision-aware Record Link current projection fields.

Revision ID: 0004_record_link_projection
Revises: 0003_candidate_change_sets
Create Date: 2026-07-27
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0004_record_link_projection"
down_revision: str | None = "0003_candidate_change_sets"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _record_id(value: object) -> str | None:
    if not isinstance(value, str) or not value.startswith("record:"):
        return None
    record_id = value.removeprefix("record:")
    return record_id if record_id and ":" not in record_id else None


def _valid_recipe_target(
    connection: sa.Connection,
    record_id: str,
    *,
    revision_no: int | None,
) -> bool:
    schema = connection.execute(
        sa.text(
            """
            SELECT schema_name, schema_version
            FROM records
            WHERE id = :record_id
            """
        ),
        {"record_id": record_id},
    ).first()
    if schema is None or schema[0] != "cocktail_recipe" or schema[1] != 1:
        return False
    if revision_no is None:
        return True
    return (
        connection.scalar(
            sa.text(
                """
                SELECT COUNT(*)
                FROM revisions
                WHERE target_type = 'record'
                  AND target_id = :record_id
                  AND revision_no = :revision_no
                """
            ),
            {"record_id": record_id, "revision_no": revision_no},
        )
        == 1
    )


def _upsert_link(
    connection: sa.Connection,
    *,
    source_id: str,
    relation: str,
    target_id: str,
    target_revision_no: int | None,
    created_at: object,
) -> None:
    existing_id = connection.scalar(
        sa.text(
            """
            SELECT id
            FROM record_links
            WHERE subject_record_id = :source_id
              AND relation = :relation
              AND object_record_id = :target_id
            """
        ),
        {
            "source_id": source_id,
            "relation": relation,
            "target_id": target_id,
        },
    )
    if existing_id is not None:
        connection.execute(
            sa.text(
                """
                UPDATE record_links
                SET target_revision_no = :target_revision_no,
                    updated_at = :updated_at,
                    removed_at = NULL
                WHERE id = :link_id
                """
            ),
            {
                "target_revision_no": target_revision_no,
                "updated_at": created_at,
                "link_id": existing_id,
            },
        )
        return
    connection.execute(
        sa.text(
            """
            INSERT INTO record_links (
                id, subject_record_id, relation, object_record_id,
                target_revision_no, created_at, updated_at, removed_at
            ) VALUES (
                :id, :source_id, :relation, :target_id,
                :target_revision_no, :created_at, :updated_at, NULL
            )
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "source_id": source_id,
            "relation": relation,
            "target_id": target_id,
            "target_revision_no": target_revision_no,
            "created_at": created_at,
            "updated_at": created_at,
        },
    )


def _backfill_cocktail_links(connection: sa.Connection) -> None:
    rows = connection.execute(
        sa.text(
            """
            SELECT id, schema_name, schema_version, payload, created_at
            FROM records
            WHERE schema_name IN (
                'cocktail_recipe',
                'cocktail_tasting',
                'cocktail_preference'
            )
            """
        )
    ).mappings()
    for row in rows:
        if row["schema_version"] != 1:
            continue
        payload = _json_object(row["payload"])
        desired: list[tuple[str, str, int | None]] = []
        if row["schema_name"] == "cocktail_recipe":
            target_id = _record_id(payload.get("parent_recipe_ref"))
            if target_id is not None:
                desired.append(("derived_from", target_id, None))
        elif row["schema_name"] == "cocktail_tasting":
            target_id = _record_id(payload.get("recipe_ref"))
            revision_no = payload.get("recipe_version")
            if target_id is not None and isinstance(revision_no, int) and revision_no >= 1:
                desired.append(("uses_recipe", target_id, revision_no))
        else:
            refs = payload.get("confirmed_favorite_recipe_refs")
            if isinstance(refs, list):
                for value in refs:
                    target_id = _record_id(value)
                    if target_id is not None:
                        desired.append(("favorite_recipe", target_id, None))
        for relation, target_id, target_revision_no in desired:
            if not _valid_recipe_target(
                connection,
                target_id,
                revision_no=target_revision_no,
            ):
                continue
            _upsert_link(
                connection,
                source_id=str(row["id"]),
                relation=relation,
                target_id=target_id,
                target_revision_no=target_revision_no,
                created_at=row["created_at"],
            )


def upgrade() -> None:
    op.add_column(
        "record_links",
        sa.Column("target_revision_no", sa.Integer(), nullable=True),
    )
    op.add_column(
        "record_links",
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "record_links",
        sa.Column("removed_at", sa.DateTime(), nullable=True),
    )
    op.execute("UPDATE record_links SET updated_at = created_at WHERE updated_at IS NULL")
    with op.batch_alter_table("record_links", recreate="always") as batch_op:
        batch_op.alter_column(
            "updated_at",
            existing_type=sa.DateTime(),
            nullable=False,
        )
        batch_op.create_check_constraint(
            "ck_record_links_target_revision",
            "target_revision_no IS NULL OR target_revision_no >= 1",
        )
    op.create_index(
        "ix_record_links_subject",
        "record_links",
        ["subject_record_id"],
    )
    op.create_index(
        "ix_record_links_object",
        "record_links",
        ["object_record_id"],
    )
    op.create_index(
        "ix_record_links_removed_at",
        "record_links",
        ["removed_at"],
    )
    _backfill_cocktail_links(op.get_bind())


def downgrade() -> None:
    op.drop_index("ix_record_links_removed_at", table_name="record_links")
    op.drop_index("ix_record_links_object", table_name="record_links")
    op.drop_index("ix_record_links_subject", table_name="record_links")
    with op.batch_alter_table("record_links", recreate="always") as batch_op:
        batch_op.drop_constraint("ck_record_links_target_revision", type_="check")
        batch_op.drop_column("removed_at")
        batch_op.drop_column("updated_at")
        batch_op.drop_column("target_revision_no")
