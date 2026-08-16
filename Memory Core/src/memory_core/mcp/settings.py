from __future__ import annotations

import ipaddress
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _is_loopback_host(value: str) -> bool:
    normalized = value.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


class McpSettings(BaseSettings):
    """MCP process settings loaded only from the process environment."""

    model_config = SettingsConfigDict(
        env_prefix="MEMORY_CORE_MCP_",
        extra="ignore",
    )

    api_base_url: str = "http://127.0.0.1:18765"
    client_token: SecretStr
    review_client_token: SecretStr | None = None
    api_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    host: str = "127.0.0.1"
    port: int = Field(default=18818, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    max_content_chars: int = Field(default=30_000, ge=4_000, le=100_000)
    expose_legacy_candidate_tool: bool = False

    @field_validator("api_base_url")
    @classmethod
    def validate_api_base_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("api_base_url must use http or https")
        if not parsed.hostname or not _is_loopback_host(parsed.hostname):
            raise ValueError("api_base_url must target a loopback host")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("api_base_url must not contain credentials, query, or fragment")
        if parsed.path not in {"", "/"}:
            raise ValueError("api_base_url must not include an API path")
        return normalized

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        normalized = value.strip()
        if not _is_loopback_host(normalized):
            raise ValueError("MCP host must be a loopback address")
        return normalized

    @field_validator("client_token")
    @classmethod
    def validate_client_token(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("client_token must not be empty")
        return value

    @field_validator("review_client_token")
    @classmethod
    def validate_review_client_token(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and not value.get_secret_value().strip():
            raise ValueError("review_client_token must not be empty")
        return value
