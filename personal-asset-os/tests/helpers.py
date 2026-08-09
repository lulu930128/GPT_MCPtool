from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.models import Account
from personal_asset_os.services import ledger

NOW = datetime(2026, 8, 6, 4, 0, tzinfo=UTC)


def add_account(
    session: Session,
    name: str,
    kind: AccountKind,
    subtype: AccountSubtype,
    *,
    liquid: bool = False,
    opening: Decimal | None = None,
) -> Account:
    account = ledger.create_account(
        session,
        name=name,
        kind=kind,
        subtype=subtype,
        is_liquid=liquid,
    )
    if opening is not None:
        ledger.opening_balance(
            session,
            account_id=account.id,
            amount=opening,
            occurred_at=NOW,
            idempotency_key=f"opening-{account.id}",
        )
    return account
