from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, cast

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field
from sqlalchemy import select

from personal_asset_os import __version__
from personal_asset_os.build import source_build_id
from personal_asset_os.database import Database
from personal_asset_os.domain.enums import FinancialEventStatus
from personal_asset_os.models import Account, LedgerTransaction
from personal_asset_os.services import financial_events, ledger, portfolio, reporting
from personal_asset_os.services.ai import connection_status
from personal_asset_os.services.broker_read import BrokerBridgeClient, BrokerSnapshotProvider
from personal_asset_os.services.fx_rates import FxRateProvider, OfficialUsdTwdRateProvider
from personal_asset_os.settings import Settings
from personal_asset_os.temporal import ensure_utc

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)


def _json_safe(value: object) -> object:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return ensure_utc(value).isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    raise TypeError(f"Unsupported MCP result value: {type(value)!r}")


def _payload(value: Mapping[str, object]) -> dict[str, object]:
    return cast(dict[str, object], _json_safe(value))


def create_mcp_server(
    database: Database,
    settings: Settings,
    broker_reader: BrokerSnapshotProvider | None = None,
    fx_reader: FxRateProvider | None = None,
) -> MCPServer:
    resolved_broker_reader = broker_reader or BrokerBridgeClient(settings)
    resolved_fx_reader = fx_reader or OfficialUsdTwdRateProvider(settings)
    mcp = MCPServer(
        "Personal Asset OS",
        instructions=(
            "Read-only access to the owner's local personal asset read models. "
            "Aggregate values are decimal strings in TWD; KGI US positions also carry explicit "
            "USD native values. Only describe KGI values as live when broker.status is complete "
            "and preserve as-of, price/FX quality, missing/stale price or FX, market scope, "
            "broker-account mapping, and reconciliation "
            "warnings. "
            "This server has no mutation tools and cannot write to the ledger."
        ),
    )

    @mcp.tool(title="資產總覽", annotations=READ_ONLY)
    def get_asset_overview() -> dict[str, object]:
        """Return aggregate asset metrics, valuation freshness, quality, and warnings."""
        with database.session() as session:
            view = reporting.dashboard(
                session,
                broker_read=resolved_broker_reader.read(),
                broker_investment_account_id=settings.broker_investment_account_id,
                broker_us_investment_account_id=settings.broker_us_investment_account_id,
                fx_provider=resolved_fx_reader,
                reporting_timezone=settings.reporting_timezone,
            )
            return _payload(
                {
                    "as_of": view["as_of"],
                    "base_currency": view["base_currency"],
                    "quality": view["quality"],
                    "metrics": view["metrics"],
                    "valuation": view["valuation"],
                    "broker": view["broker"],
                    "warnings": view["warnings"],
                }
            )

    @mcp.tool(title="帳戶清單", annotations=READ_ONLY)
    def list_asset_accounts(include_system: bool = False) -> dict[str, object]:
        """List ledger accounts and balances; system accounts are excluded by default."""
        rows: list[dict[str, object]] = []
        with database.session() as session:
            query = select(Account).order_by(Account.is_system, Account.name)
            for account in session.scalars(query):
                if account.is_system and not include_system:
                    continue
                balance = ledger.account_balance(session, account.id)
                rows.append(
                    {
                        "id": account.id,
                        "name": account.name,
                        "kind": account.kind.value,
                        "subtype": account.subtype.value,
                        "institution": account.institution,
                        "currency": account.currency,
                        "is_liquid": account.is_liquid,
                        "is_active": account.is_active,
                        "is_system": account.is_system,
                        "balance": balance,
                        "display_balance": -balance
                        if account.kind.value == "liability"
                        else balance,
                    }
                )
        return _payload({"accounts": rows, "count": len(rows)})

    @mcp.tool(title="投資部位", annotations=READ_ONLY)
    def list_asset_positions() -> dict[str, object]:
        """List derived investment positions with price provider, as-of, age, and quality."""
        with database.session() as session:
            view = portfolio.portfolio_read_model(
                session,
                broker_read=resolved_broker_reader.read(),
                broker_investment_account_id=settings.broker_investment_account_id,
                broker_us_investment_account_id=settings.broker_us_investment_account_id,
                fx_provider=resolved_fx_reader,
            )
        return _payload(
            {
                "positions": view.positions,
                "count": len(view.positions),
                "broker": view.broker,
                "warnings": view.warnings,
            }
        )

    @mcp.tool(title="近期交易", annotations=READ_ONLY)
    def list_recent_asset_transactions(
        limit: Annotated[int, Field(ge=1, le=50, description="Maximum rows to return.")] = 10,
    ) -> dict[str, object]:
        """List recent immutable transaction headers without posting-level details."""
        with database.session() as session:
            transactions = list(
                session.scalars(
                    select(LedgerTransaction)
                    .order_by(
                        LedgerTransaction.occurred_at.desc(),
                        LedgerTransaction.recorded_at.desc(),
                    )
                    .limit(limit)
                )
            )
            rows = [
                {
                    "id": item.id,
                    "occurred_at": item.occurred_at,
                    "recorded_at": item.recorded_at,
                    "description": item.description,
                    "source": item.source,
                    "status": item.status.value,
                    "reversal_of_id": item.reversal_of_id,
                }
                for item in transactions
            ]
        return _payload({"transactions": rows, "count": len(rows), "limit": limit})

    @mcp.tool(title="待處理日常記錄", annotations=READ_ONLY)
    def get_pending_financial_events(
        limit: Annotated[int, Field(ge=1, le=50, description="Maximum rows to return.")] = 20,
    ) -> dict[str, object]:
        """Return bounded pending capture summaries without mutation or raw import payloads."""
        with database.session() as session:
            events = financial_events.list_events(
                session,
                statuses=[
                    FinancialEventStatus.PENDING_MATCH,
                    FinancialEventStatus.NEEDS_REVIEW,
                ],
                limit=limit,
            )
            rows = [
                {
                    "id": event.id,
                    "event_kind": event.event_kind.value,
                    "occurred_at": event.occurred_at,
                    "amount": event.amount,
                    "currency": event.currency,
                    "description": event.description,
                    "merchant": event.merchant,
                    "status": event.status.value,
                    "version": event.version,
                    "source": event.source,
                }
                for event in events
            ]
        return _payload(
            {
                "contract_version": "paos.capture.read.v1",
                "scope": "pending_and_needs_review",
                "events": rows,
                "count": len(rows),
                "limit": limit,
            }
        )

    @mcp.tool(title="對帳狀態", annotations=READ_ONLY)
    def get_reconciliation_status() -> dict[str, object]:
        """Return the latest reconciliation evidence and unresolved differences."""
        with database.session() as session:
            view = reporting.dashboard(
                session,
                reporting_timezone=settings.reporting_timezone,
            )
            metrics = cast(Mapping[str, object], view["metrics"])
            return _payload(
                {
                    "as_of": view["as_of"],
                    "unresolved_count": metrics["unresolved_count"],
                    "unresolved_total": metrics["unresolved_total"],
                    "reconciliations": view["reconciliations"],
                    "warnings": view["warnings"],
                }
            )

    @mcp.tool(title="連線狀態", annotations=READ_ONLY)
    def get_asset_system_status() -> dict[str, object]:
        """Return non-secret build, transport, and OpenAI configuration status."""
        return _payload(
            {
                "service": "personal-asset-os",
                "version": __version__,
                "build_id": source_build_id(settings.project_root),
                "base_currency": settings.base_currency,
                "http_policy": "loopback-only",
                "mcp_policy": "private-tunnel-read-only",
                "openai": connection_status(settings),
                "broker_bridge": {
                    "enabled": settings.broker_bridge_enabled,
                    "configured": settings.broker_bridge_configured,
                    "loopback_url": settings.broker_bridge_url,
                    "ledger_account_mapping_configured": bool(
                        settings.broker_investment_account_id
                    ),
                    "us_ledger_account_mapping_configured": bool(
                        settings.broker_us_investment_account_id
                    ),
                    "fx_enabled": settings.fx_enabled,
                },
            }
        )

    return mcp
