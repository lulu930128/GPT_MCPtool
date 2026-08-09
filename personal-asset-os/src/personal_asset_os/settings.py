from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def default_data_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "PersonalAssetOS"
    return Path.home() / ".personal-asset-os"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PAOS_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = Field(default=8876, ge=1024, le=65535)
    base_currency: str = "TWD"
    data_dir: Path = Field(default_factory=default_data_dir)
    log_level: str = "info"
    tunnel_id: SecretStr | None = None
    tunnel_health_port: int = Field(default=8877, ge=1024, le=65535)
    openai_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="OPENAI_API_KEY",
        repr=False,
    )
    openai_model: str = "gpt-5.6"
    openai_timeout_seconds: float = Field(default=30.0, gt=0, le=120)

    @field_validator("host")
    @classmethod
    def validate_loopback(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Personal Asset OS may only bind to a loopback address")
        return value

    @field_validator("base_currency")
    @classmethod
    def validate_currency(cls, value: str) -> str:
        normalized = value.strip().upper()
        if normalized != "TWD":
            raise ValueError("The first version supports TWD as the only base currency")
        return normalized

    @property
    def database_path(self) -> Path:
        return self.data_dir / "data" / "personal_asset_os.db"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir / "runtime"

    @property
    def project_root(self) -> Path:
        return Path(__file__).resolve().parents[2]

    @property
    def frontend_dist(self) -> Path:
        return self.project_root / "frontend" / "dist"

    @property
    def mcp_url(self) -> str:
        return f"http://{self.host}:{self.port}/mcp/"

    @property
    def openai_configured(self) -> bool:
        return bool(
            self.openai_api_key
            and self.openai_api_key.get_secret_value().strip()
        )

    def ensure_directories(self) -> None:
        for path in (self.database_path.parent, self.backup_dir, self.log_dir, self.runtime_dir):
            path.mkdir(parents=True, exist_ok=True)
