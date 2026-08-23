from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from personal_asset_os.app import create_app
from personal_asset_os.database import Database
from personal_asset_os.settings import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        data_dir=tmp_path / "paos-data",
        broker_bridge_enabled=False,
        daily_snapshot_enabled=False,
    )


@pytest.fixture
def database(settings: Settings) -> Generator[Database, None, None]:
    app = create_app(settings)
    database: Database = app.state.database
    yield database
    database.engine.dispose()


@pytest.fixture
def session(database: Database) -> Generator[Session, None, None]:
    with database.session() as session:
        yield session


@pytest.fixture
def client(settings: Settings) -> Generator[TestClient, None, None]:
    app = create_app(settings)
    with TestClient(app) as client:
        yield client
