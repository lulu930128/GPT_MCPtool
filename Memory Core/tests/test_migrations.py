from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from alembic import command
from alembic.config import Config

from memory_core.config import Settings
from memory_core.db import Database
from memory_core.models import ClientCredential, Record
from memory_core.security import hash_token


def test_record_link_projection_backfills_cocktail_references(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "legacy-cocktail-links.db"
    monkeypatch.setenv(
        "MEMORY_CORE_DATABASE_URL",
        f"sqlite+pysqlite:///{database_path.as_posix()}",
    )
    config = Config("alembic.ini")
    command.upgrade(config, "0003_candidate_change_sets")

    created_at = datetime(2026, 7, 27, 8, 0, tzinfo=UTC).isoformat()
    client_id = str(uuid.uuid4())
    recipe_id = str(uuid.uuid4())
    tasting_id = str(uuid.uuid4())
    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute(
            """
            INSERT INTO client_credentials
                (id, name, token_hash, scopes, enabled, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (client_id, "legacy-cocktail", "c" * 64, '["*"]', 1, created_at),
        )
        for record_id, kind, title, schema_name, payload in (
            (
                recipe_id,
                "fact",
                "Legacy recipe",
                "cocktail_recipe",
                {"recipe_name": "Legacy recipe", "ingredients": []},
            ),
            (
                tasting_id,
                "event",
                "Legacy tasting",
                "cocktail_tasting",
                {
                    "cocktail_name": "Legacy tasting",
                    "recipe_ref": f"record:{recipe_id}",
                    "recipe_version": 1,
                },
            ),
        ):
            connection.execute(
                """
                INSERT INTO records (
                    id, kind, domain, title, summary, body_markdown,
                    occurred_start, occurred_end, date_precision, timezone_name,
                    importance, lifecycle_status, verification_status, sensitivity,
                    handling_policy, schema_name, schema_version, payload, source_type,
                    source_reference, supersedes_id, version, created_by_client_id,
                    deleted_at, created_at, updated_at
                ) VALUES (
                    ?, ?, 'lifestyle.cocktail', ?, NULL, NULL,
                    NULL, NULL, 'unknown', NULL,
                    50, 'active', 'confirmed', 'personal',
                    'normal', ?, 1, ?, 'manual',
                    NULL, NULL, 1, ?, NULL, ?, ?
                )
                """,
                (
                    record_id,
                    kind,
                    title,
                    schema_name,
                    json.dumps(payload),
                    client_id,
                    created_at,
                    created_at,
                ),
            )
            connection.execute(
                """
                INSERT INTO revisions (
                    id, target_type, target_id, revision_no, old_data, new_data,
                    changed_by_client_id, change_reason, created_at
                ) VALUES (?, 'record', ?, 1, NULL, '{}', ?, 'created', ?)
                """,
                (str(uuid.uuid4()), record_id, client_id, created_at),
            )
        connection.commit()

    command.upgrade(config, "head")

    with closing(sqlite3.connect(database_path)) as connection:
        row = connection.execute(
            """
            SELECT subject_record_id, relation, object_record_id,
                   target_revision_no, removed_at
            FROM record_links
            """
        ).fetchone()
        assert row == (tasting_id, "uses_recipe", recipe_id, 1, None)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_migration_round_trip_and_fts(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "migration.db"
    monkeypatch.setenv(
        "MEMORY_CORE_DATABASE_URL",
        f"sqlite+pysqlite:///{database_path.as_posix()}",
    )
    config = Config("alembic.ini")
    command.upgrade(config, "head")

    with closing(sqlite3.connect(database_path)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
        }
        assert "records" in tables
        assert "records_fts" in tables
        assert "candidate_operations" in tables
        assert "candidate_results" in tables
        assert "candidate_batches" in tables
        assert "candidate_batch_revisions" in tables
        assert "candidate_items" in tables
        assert "batch_item_operations" in tables
        assert "batch_item_results" in tables
        assert "batch_apply_attempts" in tables
        assert "collections" in tables
        assert "collection_members" in tables

    settings = Settings(
        environment="test",
        data_dir=tmp_path,
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}",
    )
    database = Database(settings)
    with database.session_factory() as session:
        credential = ClientCredential(
            name="fts-test",
            token_hash=hash_token("fts-test-token"),
            scopes=["*"],
        )
        session.add(credential)
        session.flush()
        session.add(
            Record(
                kind="reflection",
                domain="media",
                title="日文作品的閱讀進度",
                body_markdown="シュタインズ・ゲートを読み終えた。",
                created_by_client_id=credential.id,
            )
        )
        session.commit()
    database.dispose()

    with closing(sqlite3.connect(database_path)) as connection:
        chinese_count = connection.execute(
            "SELECT COUNT(*) FROM records_fts WHERE records_fts MATCH ?",
            ('"閱讀進度"',),
        ).fetchone()[0]
        japanese_count = connection.execute(
            "SELECT COUNT(*) FROM records_fts WHERE records_fts MATCH ?",
            ('"ゲート"',),
        ).fetchone()[0]
        assert chinese_count == 1
        assert japanese_count == 1

    command.downgrade(config, "base")
    with closing(sqlite3.connect(database_path)) as connection:
        tables_after_downgrade = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "records" not in tables_after_downgrade

    command.upgrade(config, "head")
    with closing(sqlite3.connect(database_path)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_remote_review_migration_backfills_legacy_applied_create(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "legacy-candidate.db"
    monkeypatch.setenv(
        "MEMORY_CORE_DATABASE_URL",
        f"sqlite+pysqlite:///{database_path.as_posix()}",
    )
    config = Config("alembic.ini")
    command.upgrade(config, "0001_initial_core")

    created_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC).isoformat()
    client_id = "legacy-client"
    record_id = "legacy-record"
    candidate_id = "legacy-candidate"
    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute(
            """
            INSERT INTO client_credentials
                (id, name, token_hash, scopes, enabled, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (client_id, "legacy", "a" * 64, '["*"]', 1, created_at),
        )
        connection.execute(
            """
            INSERT INTO records (
                id, kind, domain, title, summary, body_markdown,
                occurred_start, occurred_end, date_precision, timezone_name,
                importance, lifecycle_status, verification_status, sensitivity,
                handling_policy, schema_name, schema_version, payload, source_type,
                source_reference, supersedes_id, version, created_by_client_id,
                deleted_at, created_at, updated_at
            ) VALUES (
                ?, 'idea', 'general', 'legacy result', NULL, NULL,
                NULL, NULL, 'unknown', NULL,
                50, 'active', 'unverified', 'personal',
                'local_only', 'generic', 1, '{}', 'manual',
                NULL, NULL, 1, ?, NULL, ?, ?
            )
            """,
            (record_id, client_id, created_at, created_at),
        )
        connection.execute(
            """
            INSERT INTO memory_candidates (
                id, operation, target_type, target_id, base_version,
                proposed_content, source_type, source_reference, source_client_id,
                idempotency_key, content_hash, confidence, validation_result,
                risk_flags, status, created_at, reviewed_at, reviewed_by_client_id
            ) VALUES (
                ?, 'create', 'record', ?, NULL,
                ?, 'mcp', NULL, ?,
                'legacy-create', ?, 0.9, '{"valid": true}',
                '[]', 'applied', ?, ?, ?
            )
            """,
            (
                candidate_id,
                record_id,
                '{"kind":"idea","domain":"general","title":"legacy result"}',
                client_id,
                "b" * 64,
                created_at,
                created_at,
                client_id,
            ),
        )
        connection.commit()

    command.upgrade(config, "head")

    with closing(sqlite3.connect(database_path)) as connection:
        row = connection.execute(
            """
            SELECT target_id, result_id, result_version, review_digest,
                   review_digest_version, expires_at, candidate_kind
            FROM memory_candidates
            WHERE id = ?
            """,
            (candidate_id,),
        ).fetchone()
        assert row is not None
        assert row[0] is None
        assert row[1] == record_id
        assert row[2] == 1
        assert row[3].startswith("sha256:v1:")
        assert row[4] == 1
        assert row[5] is not None
        assert row[6] == "single"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
