from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.config import Settings
from memory_core.errors import OperationError
from memory_core.models import (
    Attachment,
    AuditEvent,
    Entity,
    EntityRelation,
    ExportManifest,
    MemoryCandidate,
    Record,
    RecordEntity,
    RecordLink,
    RecordTag,
    Revision,
    Tag,
)
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event

EXPORT_TABLES = (
    Record,
    Entity,
    Tag,
    RecordEntity,
    RecordTag,
    EntityRelation,
    RecordLink,
    Attachment,
    Revision,
    MemoryCandidate,
    AuditEvent,
)


def _row_to_json(row: Any) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for column in row.__table__.columns:
        value = getattr(row, column.name)
        if isinstance(value, datetime):
            value = value.astimezone(UTC).isoformat()
        data[column.name] = value
    return data


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_json_export(
    session: Session,
    settings: Settings,
    principal: ClientPrincipal,
    *,
    request_id: str | None,
) -> ExportManifest:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    operation_id = uuid.uuid4().hex[:8]
    destination = settings.exports_dir / f"memory-core-export-{stamp}-{operation_id}.json"
    temporary = destination.with_suffix(".json.tmp")
    tables: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    for model in EXPORT_TABLES:
        rows = list(session.scalars(select(model)))
        tables[model.__tablename__] = [_row_to_json(row) for row in rows]
        counts[model.__tablename__] = len(rows)
    document = {
        "format": "memory-core-export",
        "schema_version": 1,
        "exported_at": datetime.now(UTC).isoformat(),
        "tables": tables,
    }
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temporary, destination)
    content_hash = _sha256_file(destination)
    manifest = ExportManifest(
        operation_type="json_export",
        file_path=str(destination),
        content_hash=content_hash,
        counts=counts,
        created_by_client_id=principal.id,
    )
    session.add(manifest)
    session.flush()
    add_audit_event(
        session,
        principal,
        action="admin.export",
        outcome="success",
        request_id=request_id,
        target_type="export_manifest",
        target_id=manifest.id,
        details={"counts": counts},
    )
    return manifest


def create_sqlite_backup(
    session: Session,
    settings: Settings,
    principal: ClientPrincipal,
    *,
    request_id: str | None,
) -> ExportManifest:
    source = settings.database_path
    if source is None or not source.exists():
        raise OperationError("SQLite file backup is unavailable for this database configuration")
    session.flush()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    operation_id = uuid.uuid4().hex[:8]
    destination = settings.backups_dir / f"memory-core-{stamp}-{operation_id}.db"
    temporary = destination.with_suffix(".db.tmp")
    with closing(sqlite3.connect(source)) as source_connection:
        with closing(sqlite3.connect(temporary)) as destination_connection:
            source_connection.backup(destination_connection)
    os.replace(temporary, destination)
    verification = verify_sqlite_backup(destination)
    content_hash = _sha256_file(destination)
    counts = {
        "records": verification.get("records", 0),
        "entities": verification.get("entities", 0),
    }
    sidecar = destination.with_suffix(".manifest.json")
    sidecar_temporary = sidecar.with_suffix(".json.tmp")
    sidecar_temporary.write_text(
        json.dumps(
            {
                "format": "memory-core-sqlite-backup",
                "created_at": datetime.now(UTC).isoformat(),
                "database_file": destination.name,
                "sha256": content_hash,
                "verification": verification,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    os.replace(sidecar_temporary, sidecar)
    manifest = ExportManifest(
        operation_type="sqlite_backup",
        file_path=str(destination),
        content_hash=content_hash,
        counts=counts,
        created_by_client_id=principal.id,
    )
    session.add(manifest)
    session.flush()
    add_audit_event(
        session,
        principal,
        action="admin.backup",
        outcome="success",
        request_id=request_id,
        target_type="export_manifest",
        target_id=manifest.id,
        details={"counts": counts, "integrity": verification["integrity"]},
    )
    return manifest


def verify_sqlite_backup(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise OperationError("Backup file does not exist")
    try:
        with closing(
            sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
        ) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            integrity_status = str(integrity[0]) if integrity else "missing"
            records = int(connection.execute("SELECT COUNT(*) FROM records").fetchone()[0])
            entities = int(connection.execute("SELECT COUNT(*) FROM entities").fetchone()[0])
    except sqlite3.Error as exc:
        raise OperationError(f"Backup verification failed: {exc}") from exc
    if integrity_status != "ok":
        raise OperationError(f"Backup integrity check returned: {integrity_status}")
    return {"integrity": integrity_status, "records": records, "entities": entities}
