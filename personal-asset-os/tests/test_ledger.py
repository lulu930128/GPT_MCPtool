from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype, TransactionStatus
from personal_asset_os.errors import ConflictError, ValidationError
from personal_asset_os.models import LedgerTransaction, Posting
from personal_asset_os.services import ledger, reporting
from tests.helpers import NOW, add_account


def test_transfer_keeps_net_worth_and_expense_unchanged(session: Session) -> None:
    bank = add_account(
        session,
        "主要銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("50000"),
    )
    post = add_account(
        session,
        "郵局",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    before = reporting.dashboard(session, as_of=NOW + timedelta(minutes=1))

    ledger.record_transfer(
        session,
        from_account_id=bank.id,
        to_account_id=post.id,
        amount=Decimal("10000"),
        occurred_at=NOW + timedelta(minutes=2),
        description="帳戶互轉",
        idempotency_key="transfer-0001",
    )
    after = reporting.dashboard(session, as_of=NOW + timedelta(minutes=3))

    assert after["metrics"]["provisional_net_worth"] == before["metrics"]["provisional_net_worth"]  # type: ignore[index]
    assert after["metrics"]["monthly_expense"] == before["metrics"]["monthly_expense"]  # type: ignore[index]
    assert ledger.account_balance(session, bank.id) == Decimal("40000.000000")
    assert ledger.account_balance(session, post.id) == Decimal("11000.000000")


def test_credit_card_purchase_and_payment_do_not_double_count_expense(session: Session) -> None:
    bank = add_account(
        session,
        "銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("5000"),
    )
    card = add_account(
        session,
        "信用卡",
        AccountKind.LIABILITY,
        AccountSubtype.CREDIT_CARD,
        opening=Decimal("1000"),
    )

    ledger.record_expense(
        session,
        payment_account_id=card.id,
        amount=Decimal("500"),
        occurred_at=NOW + timedelta(hours=1),
        description="餐飲",
        idempotency_key="card-expense-0001",
    )
    after_expense = reporting.dashboard(session, as_of=NOW + timedelta(hours=2))
    ledger.pay_credit_card(
        session,
        bank_account_id=bank.id,
        card_account_id=card.id,
        amount=Decimal("500"),
        occurred_at=NOW + timedelta(hours=3),
        description="繳卡費",
        idempotency_key="card-payment-0001",
    )
    after_payment = reporting.dashboard(session, as_of=NOW + timedelta(hours=4))

    assert after_expense["metrics"]["monthly_expense"] == Decimal("500.000000")  # type: ignore[index]
    assert after_payment["metrics"]["monthly_expense"] == Decimal("500.000000")  # type: ignore[index]
    assert ledger.account_balance(session, card.id) == Decimal("-1000.000000")
    assert ledger.account_balance(session, bank.id) == Decimal("4500.000000")


def test_idempotency_returns_same_transaction_and_rejects_different_payload(
    session: Session,
) -> None:
    bank = add_account(
        session,
        "日常銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("3000"),
    )
    first, created_first = ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("150"),
        occurred_at=NOW,
        description="拉麵",
        idempotency_key="expense-retry-0001",
    )
    second, created_second = ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("150"),
        occurred_at=NOW,
        description="拉麵",
        idempotency_key="expense-retry-0001",
    )
    assert first.id == second.id
    assert created_first is True
    assert created_second is False
    assert (
        session.scalar(
            select(func.count())
            .select_from(LedgerTransaction)
            .where(LedgerTransaction.idempotency_key == "expense-retry-0001")
        )
        == 1
    )

    with pytest.raises(ConflictError):
        ledger.record_expense(
            session,
            payment_account_id=bank.id,
            amount=Decimal("151"),
            occurred_at=NOW,
            description="拉麵",
            idempotency_key="expense-retry-0001",
        )


def test_reversal_preserves_original_and_zeroes_effect(session: Session) -> None:
    wallet = add_account(
        session,
        "錢包",
        AccountKind.ASSET,
        AccountSubtype.CASH,
        liquid=True,
        opening=Decimal("1000"),
    )
    original, _ = ledger.record_expense(
        session,
        payment_account_id=wallet.id,
        amount=Decimal("250"),
        occurred_at=NOW,
        description="錯誤支出",
        idempotency_key="wrong-expense-0001",
    )
    reversal, created = ledger.reverse_transaction(
        session,
        transaction_id=original.id,
        reason="金額輸入錯誤",
        occurred_at=NOW + timedelta(minutes=1),
        idempotency_key="reversal-0001",
    )
    assert created is True
    assert original.status is TransactionStatus.REVERSED
    assert reversal.reversal_of_id == original.id
    assert ledger.account_balance(session, wallet.id) == Decimal("1000.000000")
    posting_total = session.scalar(
        select(func.sum(Posting.base_amount)).where(Posting.transaction_id == reversal.id)
    )
    assert posting_total == Decimal("0.000000")


def test_card_payment_cannot_create_unapproved_credit_balance(session: Session) -> None:
    bank = add_account(
        session,
        "付款銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    card = add_account(session, "零負債卡", AccountKind.LIABILITY, AccountSubtype.CREDIT_CARD)
    with pytest.raises(ValidationError, match="大於目前信用卡負債"):
        ledger.pay_credit_card(
            session,
            bank_account_id=bank.id,
            card_account_id=card.id,
            amount=Decimal("1"),
            occurred_at=NOW,
            description="錯誤繳款",
        )
