from __future__ import annotations

import json
from collections.abc import Generator
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from personal_asset_os import __version__
from personal_asset_os.api.schemas import (
    AccountCreate,
    BalanceObservationCreate,
    CardPaymentRequest,
    ExpenseRequest,
    FinancialEventCreate,
    FinancialEventFinalizeRequest,
    FinancialEventRejectRequest,
    FinancialEventUpdate,
    IncomeRequest,
    InstrumentCreate,
    MobileEventIngestRequest,
    MobilePairRequest,
    MonthCloseRequest,
    OpeningBalanceRequest,
    PriceCreate,
    ReservedCashUpdate,
    ReversalRequest,
    TradeRequest,
    TransactionReportingAnnotationUpsert,
    TransferRequest,
)
from personal_asset_os.build import source_build_id
from personal_asset_os.database import Database
from personal_asset_os.domain.enums import (
    ApprovalSource,
    AuditAction,
    FinancialEventStatus,
    TradeSide,
)
from personal_asset_os.errors import AuthenticationError
from personal_asset_os.models import (
    Account,
    AuditLog,
    FinancialEvent,
    Instrument,
    LedgerTransaction,
    MobileDevice,
    Snapshot,
)
from personal_asset_os.services import (
    activity_fund,
    financial_events,
    ledger,
    mobile_sync,
    portfolio,
    reporting,
    reporting_annotations,
    valuation_history,
)
from personal_asset_os.services import ai as ai_service
from personal_asset_os.services import backup as backup_service
from personal_asset_os.services.broker_read import BrokerSnapshotProvider
from personal_asset_os.services.daily_snapshot_scheduler import (
    capture_current_daily_snapshot,
)
from personal_asset_os.services.fx_rates import FxRateProvider
from personal_asset_os.services.mobile_usb_bridge import MobileUsbBridge
from personal_asset_os.settings import Settings
from personal_asset_os.temporal import utc_now

router = APIRouter(prefix="/api")


def get_database(request: Request) -> Database:
    return cast(Database, request.app.state.database)


def get_settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def get_broker_reader(request: Request) -> BrokerSnapshotProvider:
    return cast(BrokerSnapshotProvider, request.app.state.broker_reader)


def get_fx_reader(request: Request) -> FxRateProvider:
    return cast(FxRateProvider, request.app.state.fx_reader)


def get_mobile_usb_bridge(request: Request) -> MobileUsbBridge:
    return cast(MobileUsbBridge, request.app.state.mobile_usb_bridge)


def get_session(database: Database = Depends(get_database)) -> Generator[Session, None, None]:
    with database.session() as session:
        yield session


def get_mobile_device(
    authorization: Annotated[str | None, Header()] = None,
    session: Session = Depends(get_session),
) -> MobileDevice:
    if authorization is None:
        raise AuthenticationError("缺少裝置憑證")
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token.strip():
        raise AuthenticationError("裝置憑證格式不正確")
    return mobile_sync.authenticate_device(session, token)


def transaction_payload(
    transaction: LedgerTransaction, *, created: bool | None = None
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": transaction.id,
        "occurred_at": transaction.occurred_at,
        "recorded_at": transaction.recorded_at,
        "description": transaction.description,
        "source": transaction.source,
        "status": transaction.status.value,
        "reversal_of_id": transaction.reversal_of_id,
        "idempotency_key": transaction.idempotency_key,
        "postings": [
            {
                "id": posting.id,
                "account_id": posting.account_id,
                "amount": posting.amount,
                "base_amount": posting.base_amount,
                "currency": posting.currency,
                "memo": posting.memo,
            }
            for posting in transaction.postings
        ],
    }
    if created is not None:
        payload["created"] = created
    return payload


def financial_event_payload(
    event: FinancialEvent, *, created: bool | None = None
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": event.id,
        "event_kind": event.event_kind.value,
        "occurred_at": event.occurred_at,
        "captured_at": event.captured_at,
        "amount": event.amount,
        "currency": event.currency,
        "description": event.description,
        "merchant": event.merchant,
        "note": event.note,
        "category_hint": event.category_hint,
        "payment_hint": event.payment_hint,
        "source": event.source,
        "source_reference": event.source_reference,
        "device_id": event.device_id,
        "local_sequence": event.local_sequence,
        "status": event.status.value,
        "version": event.version,
        "payload_hash": event.payload_hash,
        "approval_source": event.approval_source.value if event.approval_source else None,
        "approved_at": event.approved_at,
        "matched_at": event.matched_at,
        "rejected_at": event.rejected_at,
        "rejected_reason": event.rejected_reason,
        "created_at": event.created_at,
        "updated_at": event.updated_at,
        "transaction_ids": [link.transaction_id for link in event.transaction_links],
    }
    if created is not None:
        payload["created"] = created
    return payload


def mobile_device_payload(device: MobileDevice) -> dict[str, object]:
    return {
        "id": device.id,
        "display_name": device.display_name,
        "paired_at": device.paired_at,
        "last_seen_at": device.last_seen_at,
        "last_accepted_sequence": device.last_accepted_sequence,
        "revoked_at": device.revoked_at,
        "status": "revoked" if device.revoked_at is not None else "active",
    }


@router.get("/health")
def health(
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    mobile_usb_bridge: MobileUsbBridge = Depends(get_mobile_usb_bridge),
) -> dict[str, object]:
    database_ok = False
    schema_revision: str | None = None
    try:
        with database.session() as session:
            session.execute(text("SELECT 1"))
            schema_revision = session.scalar(
                text("SELECT version_num FROM alembic_version LIMIT 1")
            )
            database_ok = True
    except Exception:
        database_ok = False
    return {
        "ok": database_ok,
        "service": "personal-asset-os",
        "version": __version__,
        "buildId": source_build_id(settings.project_root),
        "database": "ready" if database_ok else "unavailable",
        "schemaRevision": schema_revision,
        "hostPolicy": "loopback-only",
        "mobileUsbBridge": mobile_usb_bridge.snapshot(),
    }


@router.get("/readyz")
def readiness(
    database: Database = Depends(get_database), settings: Settings = Depends(get_settings)
) -> dict[str, object]:
    database_ready = False
    system_account_count = 0
    try:
        with database.session() as session:
            system_account_count = int(
                session.scalar(
                    select(func.count()).select_from(Account).where(Account.is_system.is_(True))
                )
                or 0
            )
            database_ready = system_account_count >= 6
    except Exception:
        database_ready = False
    frontend_ready = (settings.frontend_dist / "index.html").is_file()
    return {
        "ready": database_ready and frontend_ready,
        "databaseReady": database_ready,
        "frontendReady": frontend_ready,
        "systemAccountCount": system_account_count,
        "buildId": source_build_id(settings.project_root),
    }


@router.get("/dashboard")
def get_dashboard(
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    broker_reader: BrokerSnapshotProvider = Depends(get_broker_reader),
    fx_reader: FxRateProvider = Depends(get_fx_reader),
) -> dict[str, object]:
    return reporting.dashboard(
        session,
        broker_read=broker_reader.read(),
        broker_investment_account_id=settings.broker_investment_account_id,
        broker_us_investment_account_id=settings.broker_us_investment_account_id,
        fx_provider=fx_reader,
        reporting_timezone=settings.reporting_timezone,
    )


@router.post("/valuation-snapshots/daily", status_code=201)
def capture_daily_valuation_snapshot(
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    broker_reader: BrokerSnapshotProvider = Depends(get_broker_reader),
    fx_reader: FxRateProvider = Depends(get_fx_reader),
) -> dict[str, object]:
    captured_at = utc_now()
    snapshot, created = capture_current_daily_snapshot(
        session,
        settings=settings,
        broker_reader=broker_reader,
        fx_reader=fx_reader,
        captured_at=captured_at,
    )
    return {
        "created": created,
        "snapshot": valuation_history.snapshot_payload(snapshot),
    }


@router.get("/dashboard/history")
def get_dashboard_history(
    range_code: Literal["1m", "3m", "1y"] = Query(default="1m", alias="range"),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    return valuation_history.history(
        session,
        range_code=range_code,
        reporting_timezone=settings.reporting_timezone,
        base_currency=settings.base_currency,
    )


@router.get("/accounts")
def list_accounts(session: Session = Depends(get_session)) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for account in session.scalars(select(Account).order_by(Account.is_system, Account.name)):
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
                "display_balance": -balance if account.kind.value == "liability" else balance,
            }
        )
    return rows


@router.post("/accounts", status_code=201)
def add_account(
    payload: AccountCreate, session: Session = Depends(get_session)
) -> dict[str, object]:
    account = ledger.create_account(session, **payload.model_dump())
    return {"id": account.id, "name": account.name, "kind": account.kind.value}


@router.get("/activity-fund")
def get_activity_fund(session: Session = Depends(get_session)) -> dict[str, object]:
    return activity_fund.status(session)


@router.get("/mobile/transport")
def mobile_transport_status(
    mobile_usb_bridge: MobileUsbBridge = Depends(get_mobile_usb_bridge),
) -> dict[str, object]:
    return mobile_usb_bridge.snapshot()


@router.get("/financial-events")
def list_financial_events(
    status: list[FinancialEventStatus] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    rows = financial_events.list_events(session, statuses=status, limit=limit)
    return [financial_event_payload(item) for item in rows]


@router.post("/financial-events", status_code=201)
def add_financial_event(
    payload: FinancialEventCreate, session: Session = Depends(get_session)
) -> dict[str, object]:
    values = payload.model_dump()
    event_id = values.pop("id")
    event, created = financial_events.capture_event(
        session,
        event_id=str(event_id) if event_id is not None else None,
        source="local_ui",
        **values,
    )
    return financial_event_payload(event, created=created)


@router.get("/financial-events/{event_id}")
def get_financial_event(
    event_id: str, session: Session = Depends(get_session)
) -> dict[str, object]:
    return financial_event_payload(financial_events.get_event(session, event_id))


@router.patch("/financial-events/{event_id}")
def update_financial_event(
    event_id: str,
    payload: FinancialEventUpdate,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    values = payload.model_dump(exclude_unset=True)
    expected_version = cast(int, values.pop("expected_version"))
    event = financial_events.update_pending_event(
        session,
        event_id=event_id,
        expected_version=expected_version,
        patch=values,
    )
    return financial_event_payload(event)


@router.post("/financial-events/{event_id}/reject")
def reject_financial_event(
    event_id: str,
    payload: FinancialEventRejectRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    event, changed = financial_events.reject_pending_event(
        session, event_id=event_id, **payload.model_dump()
    )
    result = financial_event_payload(event)
    result["changed"] = changed
    return result


@router.post("/financial-events/{event_id}/finalize", status_code=201)
def finalize_financial_event(
    event_id: str,
    payload: FinancialEventFinalizeRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    event, transaction, created = financial_events.finalize_event(
        session,
        event_id=event_id,
        approval_source=ApprovalSource.LOCAL_UI,
        **payload.model_dump(),
    )
    return {
        "event": financial_event_payload(event),
        "transaction": transaction_payload(transaction, created=created),
        "created": created,
    }


@router.post("/mobile/pair", status_code=201)
def pair_mobile_device(
    payload: MobilePairRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    device, token = mobile_sync.pair_device(session, **payload.model_dump())
    return {
        "device": mobile_device_payload(device),
        "token": token,
        "token_type": "Bearer",
    }


@router.get("/mobile/session")
def mobile_session(
    device: MobileDevice = Depends(get_mobile_device),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    return {
        "device": mobile_device_payload(device),
        "activity_fund": activity_fund.status(session),
    }


@router.post("/mobile/events", status_code=201)
def ingest_mobile_event(
    payload: MobileEventIngestRequest,
    device: MobileDevice = Depends(get_mobile_device),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    values = payload.model_dump()
    payload_hash = cast(str, values.pop("payload_hash"))
    schema_version = cast(int, values["schema_version"])
    event, event_created = mobile_sync.capture_mobile_event(
        session,
        device=device,
        payload=values,
        payload_hash=payload_hash,
    )
    if schema_version == 1:
        return {
            "event": financial_event_payload(event, created=event_created),
            "accepted_payload_hash": payload_hash.lower(),
            "write_mode": "legacy_staging",
            "auto_finalized": False,
            "ingest_only": True,
        }

    account = activity_fund.require_account(session)
    account_arguments = (
        {"payment_account_id": account.id}
        if event.event_kind.value == "expense"
        else {"destination_account_id": account.id}
    )
    event, transaction, transaction_created = financial_events.finalize_event(
        session,
        event_id=event.id,
        expected_version=event.version,
        approval_source=ApprovalSource.PAIRED_MOBILE,
        actor=f"mobile_device:{device.id}",
        authenticated_mobile_device_id=device.id,
        **account_arguments,
    )
    return {
        "event": financial_event_payload(event, created=event_created),
        "transaction": transaction_payload(transaction, created=transaction_created),
        "accepted_payload_hash": payload_hash.lower(),
        "write_mode": activity_fund.WRITE_MODE,
        "auto_finalized": True,
    }


@router.get("/transactions")
def list_transactions(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    transactions = session.scalars(
        select(LedgerTransaction)
        .options(selectinload(LedgerTransaction.postings))
        .order_by(LedgerTransaction.occurred_at.desc(), LedgerTransaction.recorded_at.desc())
        .limit(limit)
    )
    return [transaction_payload(item) for item in transactions]


@router.put("/transactions/{transaction_id}/reporting-annotation")
def put_transaction_reporting_annotation(
    transaction_id: str,
    payload: TransactionReportingAnnotationUpsert,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    annotation, changed = reporting_annotations.set_annotation(
        session,
        transaction_id=transaction_id,
        actor="local_user",
        **payload.model_dump(),
    )
    return {
        "annotation": reporting_annotations.annotation_payload(annotation),
        "changed": changed,
        "ledger_mutated": False,
    }


@router.post("/transactions/opening-balance", status_code=201)
def add_opening_balance(
    payload: OpeningBalanceRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    transaction, created = ledger.opening_balance(session, **payload.model_dump())
    return transaction_payload(transaction, created=created)


@router.post("/transactions/expense", status_code=201)
def add_expense(
    payload: ExpenseRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    transaction, created = ledger.record_expense(session, **payload.model_dump())
    return transaction_payload(transaction, created=created)


@router.post("/transactions/income", status_code=201)
def add_income(
    payload: IncomeRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    transaction, created = ledger.record_income(session, **payload.model_dump())
    return transaction_payload(transaction, created=created)


@router.post("/transactions/transfer", status_code=201)
def add_transfer(
    payload: TransferRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    transaction, created = ledger.record_transfer(session, **payload.model_dump())
    return transaction_payload(transaction, created=created)


@router.post("/transactions/card-payment", status_code=201)
def add_card_payment(
    payload: CardPaymentRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    transaction, created = ledger.pay_credit_card(session, **payload.model_dump())
    return transaction_payload(transaction, created=created)


@router.post("/transactions/{transaction_id}/reverse", status_code=201)
def reverse(
    transaction_id: str,
    payload: ReversalRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    transaction, created = ledger.reverse_transaction(
        session, transaction_id=transaction_id, **payload.model_dump()
    )
    return transaction_payload(transaction, created=created)


@router.get("/instruments")
def list_instruments(session: Session = Depends(get_session)) -> list[dict[str, object]]:
    return [
        {
            "id": item.id,
            "symbol": item.symbol,
            "market": item.market,
            "name": item.name,
            "asset_class": item.asset_class,
            "currency": item.currency,
        }
        for item in session.scalars(
            select(Instrument).order_by(Instrument.market, Instrument.symbol)
        )
    ]


@router.post("/instruments", status_code=201)
def add_instrument(
    payload: InstrumentCreate, session: Session = Depends(get_session)
) -> dict[str, object]:
    instrument = portfolio.create_instrument(session, **payload.model_dump())
    return {"id": instrument.id, "symbol": instrument.symbol, "market": instrument.market}


@router.get("/portfolio")
def get_portfolio(
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    broker_reader: BrokerSnapshotProvider = Depends(get_broker_reader),
    fx_reader: FxRateProvider = Depends(get_fx_reader),
) -> list[portfolio.PositionRow]:
    return portfolio.portfolio_read_model(
        session,
        broker_read=broker_reader.read(),
        broker_investment_account_id=settings.broker_investment_account_id,
        broker_us_investment_account_id=settings.broker_us_investment_account_id,
        fx_provider=fx_reader,
    ).positions


@router.post("/trades", status_code=201)
def add_trade(payload: TradeRequest, session: Session = Depends(get_session)) -> dict[str, object]:
    values = payload.model_dump()
    side = values.pop("side")
    if side is TradeSide.BUY:
        transaction, created = portfolio.buy(session, **values)
    else:
        transaction, created = portfolio.sell(session, **values)
    return transaction_payload(transaction, created=created)


@router.post("/prices", status_code=201)
def add_price(payload: PriceCreate, session: Session = Depends(get_session)) -> dict[str, object]:
    fact = portfolio.record_price(session, **payload.model_dump())
    return {
        "id": fact.id,
        "instrument_id": fact.instrument_id,
        "price": fact.price,
        "price_at": fact.price_at,
        "provider": fact.provider,
        "quality": fact.quality.value,
    }


@router.post("/reconciliations", status_code=201)
def add_reconciliation(
    payload: BalanceObservationCreate, session: Session = Depends(get_session)
) -> dict[str, object]:
    observation = reporting.record_balance_observation(session, **payload.model_dump())
    return {"id": observation.id, "account_id": observation.account_id}


@router.put("/settings/reserved-cash")
def update_reserved_cash(
    payload: ReservedCashUpdate, session: Session = Depends(get_session)
) -> dict[str, object]:
    return {"value": reporting.set_reserved_cash(session, payload.value)}


@router.get("/snapshots")
def list_snapshots(session: Session = Depends(get_session)) -> list[dict[str, object]]:
    return [
        {
            "id": snapshot.id,
            "period_key": snapshot.period_key,
            "as_of": snapshot.as_of,
            "price_as_of": snapshot.price_as_of,
            "calculation_version": snapshot.calculation_version,
            "created_at": snapshot.created_at,
        }
        for snapshot in session.scalars(select(Snapshot).order_by(Snapshot.period_key.desc()))
    ]


@router.post("/snapshots/month-close", status_code=201)
def month_close(
    payload: MonthCloseRequest, session: Session = Depends(get_session)
) -> dict[str, object]:
    snapshot, created = reporting.close_month(session, **payload.model_dump())
    return {
        "id": snapshot.id,
        "period_key": snapshot.period_key,
        "as_of": snapshot.as_of,
        "created": created,
        "metrics": json.loads(snapshot.metrics_json),
    }


@router.post("/backups", status_code=201)
def create_backup(
    settings: Settings = Depends(get_settings), session: Session = Depends(get_session)
) -> dict[str, object]:
    result = backup_service.create_backup(settings.database_path, settings.backup_dir)
    session.add(
        AuditLog(
            entity_type="backup",
            entity_id=str(result["sha256"])[:36],
            action=AuditAction.BACKUP,
            actor="local_user",
            after_json=json.dumps(result, ensure_ascii=False, sort_keys=True),
        )
    )
    return result


@router.get("/system/info")
def system_info(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    return {
        "version": __version__,
        "buildId": source_build_id(settings.project_root),
        "baseCurrency": settings.base_currency,
        "hostPolicy": "loopback-only",
        "dataDirectory": str(settings.data_dir),
        "backupDirectory": str(settings.backup_dir),
        "mcpUrl": settings.mcp_url,
        "mcpPolicy": "private-tunnel-read-only",
        "openai": ai_service.connection_status(settings),
    }


@router.get("/ai/status")
def ai_status(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    """Report configuration only; this endpoint never invokes the external API."""
    return ai_service.connection_status(settings)
