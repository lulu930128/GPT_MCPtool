"""Read-time cash valuation; never writes or guesses a broker exchange rate."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import cast

from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.models import Account
from personal_asset_os.services.broker_account_state import AccountState
from personal_asset_os.services.fx_rates import FxRateProvider
from personal_asset_os.services.ledger import account_balance


def cash_projection(
    session: Session, state: AccountState | None, *, now: datetime,
    fx: object, fx_provider: FxRateProvider | None, account_id: str | None,
    accounts: list[Account],
) -> tuple[dict[str, object] | None, Decimal, list[str]]:
    if state is None:
        return None, Decimal(0), []
    fresh = -5 <= (now - state.captured_at).total_seconds() <= 120
    result: dict[str, object] = {
        **state.model_dump(mode="json"), "freshness": "current" if fresh else "stale",
        "settled_cash_twd": None, "cash_valuation_included": False,
        "cash_valuation_status": "unavailable", "cash_fx": None,
        "cash_reconciliation_status": "unmapped", "ledger_cash": None,
        "cash_difference": None, "ledger_account_id": account_id,
    }
    reported = state.settlement_status == "reported"
    receivable = sum((r.amount for r in state.settlements if r.amount > 0), Decimal(0))
    payable = sum((-r.amount for r in state.settlements if r.amount < 0), Decimal(0))
    result["settlement_schedule"] = {
        "status": "reported" if reported else "unavailable",
        "currency": "TWD", "posting_status": "unknown", "valuation_included": False,
        "reported_receivable": receivable if reported else None,
        "reported_payable": payable if reported else None,
        "reported_net": receivable - payable if reported else None,
    }
    warnings = ["交割入帳狀態尚未確認，交割款不額外納入淨資產"]
    amount = state.settled_cash
    if state.cash_quality != "qualified" or amount is None or state.liquidity_account is None:
        warnings.append("KGI 現金尚無已確認的 USD 金額，保留帳本現金")
        return result, Decimal(0), warnings
    if not fresh:
        result["cash_valuation_status"] = "stale"
        warnings.append("KGI 現金資料已過期，保留帳本現金")
        return result, Decimal(0), warnings
    fx_data = cast(dict[str, object], fx) if isinstance(fx, dict) else None
    if fx_data is None and fx_provider is not None:
        try:
            read = fx_provider.read(now=now)
            warnings.extend(read.warnings)
            fx_data = {"status": read.status, "read_mode": read.read_mode,
                       **(asdict(read.fact) if read.fact else {})}
        except Exception:
            fx_data = None
    result["cash_fx"] = fx_data
    try:
        if fx_data is None or fx_data.get("status") != "complete":
            raise ValueError("FX unavailable or stale")
        if fx_data.get("base_currency") != "USD" or fx_data.get("quote_currency") != "TWD":
            raise ValueError("FX direction")
        rate = Decimal(str(fx_data["rate"]))
        if not rate.is_finite() or rate <= 0:
            raise ValueError("FX rate")
        twd = (amount * rate).quantize(Decimal("0.000001"))
    except (ValueError, KeyError, InvalidOperation):
        warnings.append("USD/TWD 匯率不可用或已降級，券商現金未納入暫估淨資產")
        return result, Decimal(0), warnings
    result["settled_cash_twd"] = twd
    result["cash_valuation_status"] = "complete"
    delta = twd
    if account_id:
        account = next((item for item in accounts if item.id == account_id), None)
        if (account is None or account.kind != AccountKind.ASSET or account.is_system
                or not account.is_active
                or account.subtype not in {AccountSubtype.BROKER_CASH, AccountSubtype.BANK,
                                          AccountSubtype.CASH} or account.currency != "TWD"):
            result["cash_reconciliation_status"] = "invalid_mapping"
            warnings.append("KGI 現金帳戶對應無效，未套用券商現金")
            return result, Decimal(0), warnings
        ledger = account_balance(session, account.id, as_of=now)
        delta -= ledger
        result.update(ledger_cash=ledger, cash_difference=delta,
                      cash_reconciliation_status="matched" if delta == 0 else "mismatch")
    elif any(item.subtype == AccountSubtype.BROKER_CASH for item in accounts):
        result["cash_reconciliation_status"] = "mapping_required"
        warnings.append("已有券商現金帳戶，需明確對應才能納入 KGI 現金，避免雙算")
        return result, Decimal(0), warnings
    else:
        warnings.append("KGI 現金尚未連結帳本帳戶，以外部唯讀現金納入暫估淨資產")
    result["cash_valuation_included"] = True
    return result, delta, warnings
