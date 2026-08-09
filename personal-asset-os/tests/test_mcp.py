from __future__ import annotations

import asyncio

import pytest
from mcp import Client
from sqlalchemy import func, select

from personal_asset_os.database import Database
from personal_asset_os.mcp_server import create_mcp_server
from personal_asset_os.models import AuditLog, FinancialEvent, LedgerTransaction
from personal_asset_os.settings import Settings


def test_mcp_exposes_only_read_only_tools(database: Database, settings: Settings) -> None:
    server = create_mcp_server(database, settings)

    async def exercise() -> None:
        async with Client(server, raise_exceptions=True) as client:
            tools = (await client.list_tools()).tools
            expected = {
                "get_asset_overview",
                "list_asset_accounts",
                "list_asset_positions",
                "list_recent_asset_transactions",
                "get_pending_financial_events",
                "get_reconciliation_status",
                "get_asset_system_status",
            }
            assert {tool.name for tool in tools} == expected
            assert all(tool.annotations and tool.annotations.read_only_hint for tool in tools)

            with database.session() as session:
                transaction_count = select(func.count()).select_from(LedgerTransaction)
                event_count = select(func.count()).select_from(FinancialEvent)
                audit_count = select(func.count()).select_from(AuditLog)
                before = (
                    int(session.scalar(transaction_count) or 0),
                    int(session.scalar(event_count) or 0),
                    int(session.scalar(audit_count) or 0),
                )
            result = await client.call_tool("get_asset_overview", {})
            assert result.is_error is False
            assert result.structured_content is not None
            assert result.structured_content["base_currency"] == "TWD"
            with database.session() as session:
                after = (
                    int(session.scalar(transaction_count) or 0),
                    int(session.scalar(event_count) or 0),
                    int(session.scalar(audit_count) or 0),
                )
            assert after == before

            pending = await client.call_tool("get_pending_financial_events", {"limit": 10})
            assert pending.is_error is False
            assert pending.structured_content is not None
            assert pending.structured_content["contract_version"] == "paos.capture.read.v1"
            with database.session() as session:
                final = (
                    int(session.scalar(transaction_count) or 0),
                    int(session.scalar(event_count) or 0),
                    int(session.scalar(audit_count) or 0),
                )
            assert final == before

    asyncio.run(exercise())


def test_openai_key_is_secret_and_status_is_boolean(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-secret-never-log")
    settings = Settings(_env_file=None)
    assert settings.openai_configured is True
    assert "test-secret-never-log" not in repr(settings)
