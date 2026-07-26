from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from memory_core.app import create_app
from memory_core.config import Settings
from memory_core.db import Database, create_all_for_tests
from memory_core.models import ClientCredential
from memory_core.security import hash_token

ADMIN_TOKEN = "test-admin-token"
READER_TOKEN = "test-reader-token"
CANDIDATE_TOKEN = "test-candidate-token"
REVIEW_TOKEN = "test-review-token"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    database_path = tmp_path / "database" / "test.db"
    return Settings(
        environment="test",
        data_dir=tmp_path,
        database_url=f"sqlite+pysqlite:///{database_path.as_posix()}",
    )


@pytest.fixture
def database(settings: Settings) -> Iterator[Database]:
    database = Database(settings)
    create_all_for_tests(database.engine)
    with database.session_factory() as session:
        session.add_all(
            [
                ClientCredential(
                    name="admin",
                    token_hash=hash_token(ADMIN_TOKEN),
                    scopes=["*"],
                ),
                ClientCredential(
                    name="reader",
                    token_hash=hash_token(READER_TOKEN),
                    scopes=["records:read", "entities:read"],
                ),
                ClientCredential(
                    name="candidate",
                    token_hash=hash_token(CANDIDATE_TOKEN),
                    scopes=["records:read", "entities:read", "candidates:create"],
                ),
                ClientCredential(
                    name="reviewer",
                    token_hash=hash_token(REVIEW_TOKEN),
                    scopes=["candidates:review"],
                ),
            ]
        )
        session.commit()
    yield database
    database.dispose()


@pytest.fixture
def client(settings: Settings, database: Database) -> Iterator[TestClient]:
    app = create_app(settings=settings, database=database)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_headers() -> dict[str, str]:
    return {"X-Memory-Core-Token": ADMIN_TOKEN}


@pytest.fixture
def reader_headers() -> dict[str, str]:
    return {"X-Memory-Core-Token": READER_TOKEN}


@pytest.fixture
def candidate_headers() -> dict[str, str]:
    return {"X-Memory-Core-Token": CANDIDATE_TOKEN}


@pytest.fixture
def review_headers() -> dict[str, str]:
    return {"X-Memory-Core-Token": REVIEW_TOKEN}
