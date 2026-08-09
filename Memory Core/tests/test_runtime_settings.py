from __future__ import annotations

from memory_core.config import Settings
from memory_core.mcp.settings import McpSettings
from memory_core.viewer.settings import ViewerSettings


def test_runtime_defaults_use_the_same_backend_port(monkeypatch) -> None:
    monkeypatch.delenv("MEMORY_CORE_PORT", raising=False)
    monkeypatch.delenv("MEMORY_CORE_MCP_API_BASE_URL", raising=False)
    monkeypatch.delenv("MEMORY_CORE_CONTROL_CENTER_API_BASE_URL", raising=False)
    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", "mcore_test")

    backend = Settings(_env_file=None)
    mcp = McpSettings(client_token="mcore_test")
    viewer = ViewerSettings.from_environment()

    assert backend.port == 18765
    assert mcp.api_base_url == "http://127.0.0.1:18765"
    assert viewer.api_base_url == "http://127.0.0.1:18765"


def test_backend_port_can_be_overridden_without_loading_dotenv(monkeypatch) -> None:
    monkeypatch.setenv("MEMORY_CORE_PORT", "19001")

    settings = Settings(_env_file=None)

    assert settings.port == 19001
