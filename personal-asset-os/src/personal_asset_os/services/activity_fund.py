from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.errors import ServiceUnavailableError
from personal_asset_os.models import Account

ACTIVITY_FUND_SUBTYPES = (AccountSubtype.CASH, AccountSubtype.BANK)
WRITE_MODE = "single_activity_fund"


def candidates(session: Session) -> list[Account]:
    """Return accounts eligible to represent the user's activity funds."""
    return list(
        session.scalars(
            select(Account)
            .where(
                Account.is_system.is_(False),
                Account.is_active.is_(True),
                Account.is_liquid.is_(True),
                Account.kind == AccountKind.ASSET,
                Account.currency == "TWD",
                Account.subtype.in_(ACTIVITY_FUND_SUBTYPES),
            )
            .order_by(Account.name, Account.id)
        )
    )


def status(session: Session) -> dict[str, object]:
    accounts = candidates(session)
    account = accounts[0] if len(accounts) == 1 else None
    return {
        "write_mode": WRITE_MODE,
        "ready": account is not None,
        "candidate_count": len(accounts),
        "account": (
            {
                "id": account.id,
                "name": account.name,
                "currency": account.currency,
                "subtype": account.subtype.value,
            }
            if account is not None
            else None
        ),
    }


def require_account(session: Session) -> Account:
    accounts = candidates(session)
    if not accounts:
        raise ServiceUnavailableError(
            "尚未建立唯一的活動資金帳戶；請先在桌面「帳戶」頁建立活動資金",
            details={"write_mode": WRITE_MODE, "candidate_count": 0},
        )
    if len(accounts) > 1:
        raise ServiceUnavailableError(
            "找到多個活動資金候選帳戶，系統不會自行猜測；請先在桌面整理為一個",
            details={
                "write_mode": WRITE_MODE,
                "candidate_count": len(accounts),
                "account_ids": [account.id for account in accounts],
            },
        )
    return accounts[0]
