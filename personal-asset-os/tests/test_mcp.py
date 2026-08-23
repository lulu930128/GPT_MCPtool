from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from mcp import Client
from sqlalchemy import func, select

from personal_asset_os.database import Database
from personal_asset_os.mcp_server import create_mcp_server
from personal_asset_os.models import AuditLog, FinancialEvent, LedgerTransaction
from personal_asset_os.settings import Settings
from tests.broker_helpers import FakeBrokerReader, broker_result


def test_mcp_exposes_only_read_only_tools(database: Database, settings: Settings) -> None:
    reader = FakeBrokerReader(broker_result(as_of=datetime(2026, 8, 20, 2, 0, tzinfo=UTC)))
    server = create_mcp_server(database, settings, reader)

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
            assert result.structured_content["broker"]["status"] == "complete"
            assert result.structured_content["metrics"]["investment_market_value"] == "12000.000000"
            with database.session() as session:
                after = (
                    int(session.scalar(transaction_count) or 0),
                    int(session.scalar(event_count) or 0),
                    int(session.scalar(audit_count) or 0),
                )
            assert after == before

            positions = await client.call_tool("list_asset_positions", {})
            assert positions.is_error is False
            assert positions.structured_content is not None
            assert positions.structured_content["broker"]["status"] == "complete"
            assert positions.structured_content["positions"][0]["position_source"] == "kgi_broker"

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
