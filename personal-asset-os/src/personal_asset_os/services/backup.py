from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from personal_asset_os.errors import NotFoundError, UnsafeOperationError, ValidationError
from personal_asset_os.temporal import ensure_utc, utc_now


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def integrity_check(path: Path) -> str:
    if not path.is_file():
        raise NotFoundError("找不到 SQLite 檔案", details={"path": str(path)})
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute("PRAGMA integrity_check").fetchone()
        result = str(row[0]) if row else "missing_result"
    finally:
        connection.close()
    if result.lower() != "ok":
        raise ValidationError("SQLite integrity check 失敗", details={"result": result})
    return result


def create_backup(
    database_path: Path, backup_dir: Path, *, now: datetime | None = None
) -> dict[str, object]:
    if not database_path.is_file():
        raise NotFoundError("正式資料庫尚未建立")
    timestamp = ensure_utc(now or utc_now()).strftime("%Y%m%dT%H%M%SZ")
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"personal_asset_os_{timestamp}.db"
    if target.exists():
        raise UnsafeOperationError("同名備份已存在，拒絕覆寫")
    source_connection = sqlite3.connect(str(database_path))
    target_connection = sqlite3.connect(str(target))
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
    integrity = integrity_check(target)
    manifest = {
        "backup_path": str(target),
        "created_at": ensure_utc(now or utc_now()).isoformat(),
        "source_path": str(database_path),
        "size_bytes": target.stat().st_size,
        "sha256": _sha256(target),
        "integrity_check": integrity,
    }
    manifest_path = target.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {**manifest, "manifest_path": str(manifest_path)}


def verify_backup(path: Path) -> dict[str, object]:
    integrity = integrity_check(path)
    manifest_path = path.with_suffix(".manifest.json")
    expected_sha: str | None = None
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected_sha = str(manifest.get("sha256")) if manifest.get("sha256") else None
    actual_sha = _sha256(path)
    if expected_sha is not None and expected_sha != actual_sha:
        raise ValidationError("備份 hash 與 manifest 不符")
    return {
        "backup_path": str(path),
        "size_bytes": path.stat().st_size,
        "sha256": actual_sha,
        "manifest_sha256": expected_sha,
        "integrity_check": integrity,
        "verified": True,
    }


def restore_backup(source: Path, destination: Path) -> dict[str, object]:
    verify_backup(source)
    if destination.exists():
        raise UnsafeOperationError("還原目的地已存在，第一版拒絕覆寫")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + ".restoring")
    if temp.exists():
        raise UnsafeOperationError("還原暫存檔已存在，請先人工確認")
    try:
        shutil.copy2(source, temp)
        integrity_check(temp)
        temp.replace(destination)
    except Exception:
        if temp.exists():
            temp.unlink()
        raise
    return {
        "source": str(source),
        "destination": str(destination),
        "sha256": _sha256(destination),
        "integrity_check": integrity_check(destination),
    }
