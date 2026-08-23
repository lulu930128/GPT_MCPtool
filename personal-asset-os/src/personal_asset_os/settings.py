from __future__ import annotations

import os
import re
from datetime import time
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator
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
    port: int = Field(default=18876, ge=1024, le=65535)
    base_currency: str = "TWD"
    reporting_timezone: str = "Asia/Taipei"
    daily_snapshot_enabled: bool = True
    daily_snapshot_local_time: str = "06:30"
    data_dir: Path = Field(default_factory=default_data_dir)
    log_level: str = "info"
    tunnel_id: SecretStr | None = None
    tunnel_health_port: int = Field(default=18877, ge=1024, le=65535)
    openai_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="OPENAI_API_KEY",
        repr=False,
    )
    openai_model: str = "gpt-5.6"
    openai_timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    broker_bridge_enabled: bool = False
    broker_bridge_url: str = "http://127.0.0.1:18878"
    broker_bridge_api_token: SecretStr | None = Field(default=None, repr=False)
    broker_bridge_timeout_seconds: float = Field(default=50.0, gt=0, le=120)
    broker_bridge_autostart: bool = True
    broker_bridge_startup_timeout_seconds: float = Field(default=8.0, gt=0, le=30)
    broker_cache_ttl_seconds: float = Field(default=20.0, ge=0, le=300)
    broker_memory_fallback_seconds: float = Field(default=300.0, ge=0, le=3600)
    broker_price_max_age_seconds: float = Field(default=300.0, gt=0, le=86400)
    broker_investment_account_id: str | None = None
    broker_us_investment_account_id: str | None = None
    fx_enabled: bool = True
    fx_taifex_url: str = "https://openapi.taifex.com.tw/v1/DailyForeignExchangeRates"
    fx_cbc_url: str = "https://cpx.cbc.gov.tw/API/DataAPI/Get?FileName=BP01D01"
    fx_bot_url: str = "https://rate.bot.com.tw/xrt/fltxt/0/day"
    fx_timeout_seconds: float = Field(default=8.0, gt=0, le=30)
    fx_cache_ttl_seconds: float = Field(default=900.0, ge=0, le=86400)
    fx_memory_fallback_seconds: float = Field(default=86400.0, ge=0, le=345600)
    fx_rate_max_age_seconds: float = Field(default=345600.0, gt=0, le=604800)
    mobile_usb_bridge_enabled: bool = False
    mobile_adb_path: Path | None = None
    mobile_adb_server_socket: str | None = None
    mobile_adb_serial: str | None = None
    mobile_usb_bridge_poll_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    mobile_adb_command_timeout_seconds: float = Field(default=5.0, ge=1.0, le=30.0)

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

    @field_validator("reporting_timezone")
    @classmethod
    def validate_reporting_timezone(cls, value: str) -> str:
        normalized = value.strip()
        try:
            ZoneInfo(normalized)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("PAOS_REPORTING_TIMEZONE must be a valid IANA timezone") from exc
        return normalized

    @field_validator("daily_snapshot_local_time")
    @classmethod
    def validate_daily_snapshot_local_time(cls, value: str) -> str:
        normalized = value.strip()
        try:
            parsed = time.fromisoformat(normalized)
        except ValueError as exc:
            raise ValueError(
                "PAOS_DAILY_SNAPSHOT_LOCAL_TIME must use HH:MM in 24-hour time"
            ) from exc
        if parsed.tzinfo is not None or parsed.second or parsed.microsecond:
            raise ValueError(
                "PAOS_DAILY_SNAPSHOT_LOCAL_TIME must use HH:MM in local wall time"
            )
        return parsed.strftime("%H:%M")

    @property
    def daily_snapshot_wall_time(self) -> time:
        return time.fromisoformat(self.daily_snapshot_local_time)

    @field_validator("broker_bridge_url")
    @classmethod
    def validate_broker_bridge_url(cls, value: str) -> str:
        parsed = urlsplit(value.strip())
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("KGI Broker Bridge URL must use HTTP on a loopback host")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError(
                "KGI Broker Bridge URL must not contain credentials, query, or fragment"
            )
        if parsed.path not in {"", "/"}:
            raise ValueError("KGI Broker Bridge URL must not contain a path")
        return value.strip().rstrip("/")

    @field_validator("broker_investment_account_id", "broker_us_investment_account_id")
    @classmethod
    def normalize_broker_account_id(cls, value: str | None) -> str | None:
        normalized = value.strip() if value else ""
        return normalized or None

    @field_validator("fx_taifex_url", "fx_cbc_url", "fx_bot_url")
    @classmethod
    def validate_fx_url(cls, value: str) -> str:
        parsed = urlsplit(value.strip())
        if parsed.scheme != "https" or parsed.hostname not in {
            "cpx.cbc.gov.tw",
            "openapi.taifex.com.tw",
            "rate.bot.com.tw",
        }:
            raise ValueError(
                "FX sources must use the configured TAIFEX, CBC, or Bank of Taiwan host"
            )
        if parsed.username or parsed.password or parsed.fragment:
            raise ValueError("FX source URL must not contain credentials or fragments")
        return value.strip()

    @field_validator("mobile_adb_path")
    @classmethod
    def validate_mobile_adb_path(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        normalized = value.expanduser()
        if not normalized.is_absolute():
            raise ValueError("PAOS_MOBILE_ADB_PATH must be an absolute path")
        return normalized

    @field_validator("mobile_adb_server_socket")
    @classmethod
    def validate_mobile_adb_server_socket(cls, value: str | None) -> str | None:
        normalized = value.strip() if value else ""
        if not normalized:
            return None
        match = re.fullmatch(r"tcp:(?:localhost|127\.0\.0\.1):(\d{1,5})", normalized)
        if match is None or not 1 <= int(match.group(1)) <= 65535:
            raise ValueError(
                "PAOS_MOBILE_ADB_SERVER_SOCKET must use tcp:localhost:<port>"
            )
        return normalized

    @field_validator("mobile_adb_serial")
    @classmethod
    def validate_mobile_adb_serial(cls, value: str | None) -> str | None:
        normalized = value.strip() if value else ""
        if not normalized:
            return None
        if len(normalized) > 80 or re.fullmatch(r"[A-Za-z0-9._:-]+", normalized) is None:
            raise ValueError("PAOS_MOBILE_ADB_SERIAL contains unsupported characters")
        return normalized

    @model_validator(mode="after")
    def validate_broker_configuration(self) -> Settings:
        if not self.broker_bridge_enabled:
            return self
        token = (
            self.broker_bridge_api_token.get_secret_value().strip()
            if self.broker_bridge_api_token
            else ""
        )
        if len(token) < 32:
            raise ValueError(
                "PAOS_BROKER_BRIDGE_API_TOKEN must contain at least 32 characters when enabled"
            )
        return self

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

    @property
    def broker_bridge_configured(self) -> bool:
        return bool(
            self.broker_bridge_enabled
            and self.broker_bridge_api_token
            and self.broker_bridge_api_token.get_secret_value().strip()
        )

    @property
    def broker_bridge_project_root(self) -> Path:
        return self.project_root / "kgi_broker_bridge"

    @property
    def broker_bridge_python(self) -> Path:
        return self.broker_bridge_project_root / ".venv" / "Scripts" / "python.exe"

    def ensure_directories(self) -> None:
        for path in (self.database_path.parent, self.backup_dir, self.log_dir, self.runtime_dir):
            path.mkdir(parents=True, exist_ok=True)
