from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config


def run_migrations(database_path: Path, project_root: Path) -> None:
    config = Config(str(project_root / "alembic.ini"))
    config.set_main_option("script_location", str(project_root / "migrations"))
    database_url = f"sqlite:///{database_path.as_posix()}"
    config.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(config, "head")
