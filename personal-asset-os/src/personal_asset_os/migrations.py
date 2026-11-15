from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory


def code_only_schema_preflight(database_path: Path, project_root: Path) -> dict[str, object]:
    """Read only Alembic metadata; never create a DB, migrate or load the app."""
    config = Config(str(project_root / "alembic.ini"))
    config.set_main_option("script_location", str(project_root / "migrations"))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        return {"allowed": False, "code": "UPDATE_SCHEMA_HEAD_UNVERIFIED"}
    try:
        uri = database_path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            rows = db.execute("SELECT version_num FROM alembic_version").fetchall()
    except sqlite3.Error:
        return {"allowed": False, "code": "UPDATE_SCHEMA_STATE_UNVERIFIED"}
    compatible = rows == [(heads[0],)]
    return {
        "allowed": compatible, "code": "SCHEMA_COMPATIBLE" if compatible else "MIGRATION_REQUIRED"
    }


def run_migrations(database_path: Path, project_root: Path) -> None:
    config = Config(str(project_root / "alembic.ini"))
    config.set_main_option("script_location", str(project_root / "migrations"))
    database_url = f"sqlite:///{database_path.as_posix()}"
    config.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(config, "head")
