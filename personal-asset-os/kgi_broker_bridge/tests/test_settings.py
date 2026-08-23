from __future__ import annotations

import sys

import pytest
from pydantic import ValidationError

from kgi_broker_bridge.settings import Settings

TOKEN = "synthetic-local-api-token-for-tests-0001"


def test_settings_require_loopback_and_non_placeholder_token() -> None:
    settings = Settings(_env_file=None, api_token=TOKEN)
    assert settings.host == "127.0.0.1"
    assert TOKEN not in repr(settings)

    with pytest.raises(ValidationError, match="loopback"):
        Settings(_env_file=None, api_token=TOKEN, host="0.0.0.0")
    with pytest.raises(ValidationError, match="non-placeholder"):
        Settings(
            _env_file=None,
            api_token="replace-with-a-random-local-token-at-least-32-characters",
        )
    with pytest.raises(ValidationError, match="runtime directory"):
        Settings(_env_file=None, api_token=TOKEN, runtime_dir="relative-runtime")


def test_live_adapter_requires_secrets_hash_key_and_existing_sdk_python() -> None:
    with pytest.raises(ValidationError, match="PERSON_ID"):
        Settings(_env_file=None, api_token=TOKEN, adapter_mode="kgisuperpy")

    settings = Settings(
        _env_file=None,
        api_token=TOKEN,
        adapter_mode="kgisuperpy",
        account_hash_key="synthetic-hmac-key-for-tests-0001",
        person_id="SYNTHETIC-PERSON-ID",
        person_password="SYNTHETIC-PASSWORD",
        sdk_python=sys.executable,
    )
    rendered = repr(settings)
    assert settings.adapter_mode == "kgisuperpy"
    assert "SYNTHETIC-PERSON-ID" not in rendered
    assert "SYNTHETIC-PASSWORD" not in rendered

    with pytest.raises(ValidationError, match="must differ"):
        Settings(
            _env_file=None,
            api_token=TOKEN,
            account_hash_key=TOKEN,
        )

    with pytest.raises(ValidationError, match="PERSON_PASSWORD"):
        Settings(
            _env_file=None,
            api_token=TOKEN,
            adapter_mode="kgisuperpy",
            account_hash_key="synthetic-hmac-key-for-tests-0001",
            person_id="SYNTHETIC-PERSON-ID",
            person_password="replace-with-kgi-password",
            sdk_python=sys.executable,
        )
