from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MEMORY_CORE_",
        extra="ignore",
    )

    app_name: str = "Memory Core"
    environment: str = "development"
    host: str = "127.0.0.1"
    port: int = Field(default=18765, ge=1, le=65535)
    data_dir: Path = Path("data")
    database_url: str | None = None
    log_level: str = "INFO"
    allowed_origins: list[str] = Field(default_factory=list)
    allowed_hosts: list[str] = Field(
        default_factory=lambda: ["127.0.0.1", "localhost", "testserver"]
    )

    @property
    def database_path(self) -> Path | None:
        if self.database_url:
            prefix = "sqlite+pysqlite:///"
            if self.database_url.startswith(prefix):
                raw_path = self.database_url.removeprefix(prefix)
                if raw_path == ":memory:":
                    return None
                return Path(raw_path).resolve()
            return None
        return (self.data_dir / "database" / "memory_core.db").resolve()

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        database_path = self.database_path
        if database_path is None:  # pragma: no cover - guarded by the branch above
            raise RuntimeError("Unable to resolve the SQLite database path")
        return f"sqlite+pysqlite:///{database_path.as_posix()}"

    @property
    def exports_dir(self) -> Path:
        return (self.data_dir / "exports").resolve()

    @property
    def backups_dir(self) -> Path:
        return (self.data_dir / "backups").resolve()

    def ensure_local_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        if self.database_path is not None:
            self.database_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
