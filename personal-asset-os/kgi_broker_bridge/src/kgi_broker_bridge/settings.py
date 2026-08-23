from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def default_runtime_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "PersonalAssetOS" / "runtime" / "kgi-broker-bridge"
    return Path.home() / ".personal-asset-os" / "runtime" / "kgi-broker-bridge"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KGI_BRIDGE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = Field(default=18878, ge=1024, le=65535)
    api_token: SecretStr
    account_hash_key: SecretStr | None = None
    adapter_mode: Literal["disabled", "kgisuperpy"] = "disabled"
    person_id: SecretStr | None = None
    person_password: SecretStr | None = None
    simulation: bool = False
    stock_account: SecretStr | None = None
    sub_account: SecretStr | None = None
    sdk_python: Path | None = None
    sdk_timeout_seconds: float = Field(default=45.0, ge=5.0, le=180.0)
    runtime_dir: Path = Field(default_factory=default_runtime_dir)
    log_level: str = "info"

    @field_validator("host")
    @classmethod
    def validate_loopback(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("KGI Broker Bridge may only bind to a loopback address")
        return value

    @field_validator("runtime_dir")
    @classmethod
    def validate_runtime_dir(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("KGI Broker Bridge runtime directory must be absolute")
        return value

    @field_validator("api_token")
    @classmethod
    def validate_api_token(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value().strip()
        if len(raw) < 32 or "replace-with" in raw.lower():
            raise ValueError("api token must be a non-placeholder value of at least 32 characters")
        return SecretStr(raw)

    @field_validator("account_hash_key")
    @classmethod
    def validate_account_hash_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        raw = value.get_secret_value().strip()
        if len(raw) < 32 or "replace-with" in raw.lower():
            raise ValueError(
                "account hash key must be a non-placeholder value of at least 32 characters"
            )
        return SecretStr(raw)

    @field_validator("person_id", "person_password", "stock_account", "sub_account")
    @classmethod
    def normalize_optional_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        raw = value.get_secret_value().strip()
        return SecretStr(raw) if raw else None

    @model_validator(mode="after")
    def validate_live_adapter(self) -> Self:
        if (
            self.account_hash_key is not None
            and self.account_hash_key.get_secret_value()
            == self.api_token.get_secret_value()
        ):
            raise ValueError("account hash key must differ from the API token")
        if self.adapter_mode != "kgisuperpy":
            return self

        missing: list[str] = []
        if not _live_secret_is_configured(self.person_id):
            missing.append("KGI_BRIDGE_PERSON_ID")
        if not _live_secret_is_configured(self.person_password):
            missing.append("KGI_BRIDGE_PERSON_PASSWORD")
        if not secret_is_configured(self.account_hash_key):
            missing.append("KGI_BRIDGE_ACCOUNT_HASH_KEY")
        if self.sdk_python is None:
            missing.append("KGI_BRIDGE_SDK_PYTHON")
        if missing:
            raise ValueError(f"kgisuperpy adapter requires: {', '.join(missing)}")

        assert self.sdk_python is not None
        if not self.sdk_python.is_absolute() or not self.sdk_python.is_file():
            raise ValueError("KGI_BRIDGE_SDK_PYTHON must be an existing absolute file")
        return self


def secret_is_configured(value: SecretStr | None) -> bool:
    return bool(value and value.get_secret_value())


def _live_secret_is_configured(value: SecretStr | None) -> bool:
    if not secret_is_configured(value):
        return False
    assert value is not None
    return "replace-with" not in value.get_secret_value().casefold()
