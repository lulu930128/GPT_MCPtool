from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    AuditAction,
    TransactionStatus,
)
from personal_asset_os.errors import (
    ConflictError,
    DataIntegrityError,
    NotFoundError,
    ValidationError,
)
from personal_asset_os.models import Account, AuditLog, LedgerTransaction, Posting
from personal_asset_os.temporal import ensure_utc, utc_now

MONEY_QUANT = Decimal("0.000001")
ZERO = Decimal("0").quantize(MONEY_QUANT)


@dataclass(frozen=True, slots=True)
class PostingDraft:
    account_id: str
    amount: Decimal
    base_amount: Decimal
    currency: str = "TWD"
    memo: str | None = None


def money(value: Decimal | str | int) -> Decimal:
    try:
        result = Decimal(str(value)).quantize(MONEY_QUANT)
    except (InvalidOperation, ValueError) as exc:
        raise ValidationError("金額格式不正確") from exc
    if not result.is_finite():
        raise ValidationError("金額必須是有限數值")
    return result


def positive_money(value: Decimal | str | int, label: str = "金額") -> Decimal:
    result = money(value)
    if result <= ZERO:
        raise ValidationError(f"{label}必須大於零")
    return result


def _canonical_payload(
    *,
    occurred_at: datetime,
    description: str,
    source: str,
    postings: list[PostingDraft],
    reversal_of_id: str | None,
) -> tuple[str, str]:
    payload = {
        "occurred_at": ensure_utc(occurred_at).isoformat(),
        "description": description.strip(),
        "source": source,
        "reversal_of_id": reversal_of_id,
        "postings": [
            {
                "account_id": item.account_id,
                "amount": str(money(item.amount)),
                "base_amount": str(money(item.base_amount)),
                "currency": item.currency.upper(),
                "memo": item.memo,
            }
            for item in postings
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return encoded, hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _audit(
    session: Session,
    *,
    entity_type: str,
    entity_id: str,
    action: AuditAction,
    actor: str,
    after: dict[str, object] | None = None,
    before: dict[str, object] | None = None,
    reason: str | None = None,
) -> None:
    session.add(
        AuditLog(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            before_json=(
                json.dumps(before, ensure_ascii=False, sort_keys=True) if before else None
            ),
            after_json=(json.dumps(after, ensure_ascii=False, sort_keys=True) if after else None),
            actor=actor,
            reason=reason,
        )
    )


SYSTEM_ACCOUNTS: tuple[tuple[str, AccountKind, AccountSubtype], ...] = (
    ("期初權益", AccountKind.EQUITY, AccountSubtype.OPENING_BALANCE),
    ("日常支出", AccountKind.EXPENSE, AccountSubtype.GENERAL_EXPENSE),
    ("薪資收入", AccountKind.INCOME, AccountSubtype.SALARY),
    ("投資手續費", AccountKind.EXPENSE, AccountSubtype.INVESTMENT_FEE),
    ("已實現投資損益", AccountKind.INCOME, AccountSubtype.REALIZED_PNL),
    ("待配對交易", AccountKind.CLEARING, AccountSubtype.UNMATCHED),
)


def seed_system_accounts(session: Session) -> None:
    existing = {
        subtype
        for subtype in session.scalars(select(Account.subtype).where(Account.is_system.is_(True)))
    }
    for name, kind, subtype in SYSTEM_ACCOUNTS:
        if subtype in existing:
            continue
        session.add(
            Account(
                name=name,
                kind=kind,
                subtype=subtype,
                currency="TWD",
                is_liquid=False,
                is_active=True,
                is_system=True,
            )
        )
    session.flush()


def create_account(
    session: Session,
    *,
    name: str,
    kind: AccountKind,
    subtype: AccountSubtype,
    institution: str | None = None,
    currency: str = "TWD",
    is_liquid: bool = False,
    actor: str = "local_user",
) -> Account:
    clean_name = name.strip()
    if not clean_name:
        raise ValidationError("帳戶名稱不可為空")
    if currency.upper() != "TWD":
        raise ValidationError("第一版只支援 TWD 帳戶")
    if session.scalar(select(Account).where(func.lower(Account.name) == clean_name.lower())):
        raise ConflictError("帳戶名稱已存在")

    valid_subtypes: dict[AccountKind, set[AccountSubtype]] = {
        AccountKind.ASSET: {
            AccountSubtype.CASH,
            AccountSubtype.BANK,
            AccountSubtype.BROKER_CASH,
            AccountSubtype.INVESTMENT,
            AccountSubtype.OTHER,
        },
        AccountKind.LIABILITY: {AccountSubtype.CREDIT_CARD, AccountSubtype.OTHER},
        AccountKind.EQUITY: {AccountSubtype.OTHER, AccountSubtype.OPENING_BALANCE},
        AccountKind.INCOME: {
            AccountSubtype.SALARY,
            AccountSubtype.REALIZED_PNL,
            AccountSubtype.OTHER,
        },
        AccountKind.EXPENSE: {
            AccountSubtype.GENERAL_EXPENSE,
            AccountSubtype.INVESTMENT_FEE,
            AccountSubtype.OTHER,
        },
        AccountKind.CLEARING: {AccountSubtype.UNMATCHED, AccountSubtype.OTHER},
    }
    if subtype not in valid_subtypes[kind]:
        raise ValidationError("帳戶類型與子類型不相容")
    if is_liquid and kind is not AccountKind.ASSET:
        raise ValidationError("只有資產帳戶可標記為流動資金")

    account = Account(
        name=clean_name,
        kind=kind,
        subtype=subtype,
        institution=(institution.strip() if institution else None),
        currency="TWD",
        is_liquid=is_liquid,
        is_active=True,
        is_system=False,
    )
    session.add(account)
    session.flush()
    _audit(
        session,
        entity_type="account",
        entity_id=account.id,
        action=AuditAction.CREATE,
        actor=actor,
        after={"name": account.name, "kind": account.kind.value, "subtype": account.subtype.value},
    )
    return account


def require_account(session: Session, account_id: str) -> Account:
    account = session.get(Account, account_id)
    if account is None:
        raise NotFoundError("找不到帳戶", details={"account_id": account_id})
    if not account.is_active:
        raise ValidationError("帳戶已停用", details={"account_id": account_id})
    return account


def system_account(session: Session, subtype: AccountSubtype) -> Account:
    account = session.scalar(
        select(Account).where(Account.is_system.is_(True), Account.subtype == subtype)
    )
    if account is None:
        raise DataIntegrityError("缺少系統帳戶", details={"subtype": subtype.value})
    return account


def create_transaction(
    session: Session,
    *,
    occurred_at: datetime,
    description: str,
    postings: list[PostingDraft],
    source: str = "manual",
    idempotency_key: str | None = None,
    actor: str = "local_user",
    reversal_of_id: str | None = None,
) -> tuple[LedgerTransaction, bool]:
    clean_description = description.strip()
    if not clean_description:
        raise ValidationError("交易描述不可為空")
    if len(postings) < 2:
        raise ValidationError("每筆交易至少需要兩個 posting")

    _, payload_hash = _canonical_payload(
        occurred_at=occurred_at,
        description=clean_description,
        source=source,
        postings=postings,
        reversal_of_id=reversal_of_id,
    )
    if idempotency_key:
        existing = session.scalar(
            select(LedgerTransaction)
            .options(selectinload(LedgerTransaction.postings))
            .where(LedgerTransaction.idempotency_key == idempotency_key)
        )
        if existing is not None:
            if existing.payload_hash != payload_hash:
                raise ConflictError("相同 idempotency key 對應不同交易內容")
            return existing, False

    total = ZERO
    validated: list[tuple[Account, PostingDraft, Decimal, Decimal]] = []
    for draft in postings:
        account = require_account(session, draft.account_id)
        amount = money(draft.amount)
        base_amount = money(draft.base_amount)
        currency = draft.currency.upper()
        if amount == ZERO or base_amount == ZERO:
            raise ValidationError("posting 金額不可為零")
        if currency != account.currency:
            raise ValidationError("posting 幣別與帳戶幣別不同")
        if currency != "TWD" or amount != base_amount:
            raise ValidationError("第一版要求 TWD amount 與 base_amount 相同")
        total += base_amount
        validated.append((account, draft, amount, base_amount))
    if total.quantize(MONEY_QUANT) != ZERO:
        raise DataIntegrityError(
            "交易未平衡",
            details={"base_total": str(total.quantize(MONEY_QUANT))},
        )

    transaction = LedgerTransaction(
        occurred_at=ensure_utc(occurred_at),
        description=clean_description,
        source=source,
        status=TransactionStatus.POSTED,
        reversal_of_id=reversal_of_id,
        idempotency_key=idempotency_key,
        payload_hash=payload_hash,
        created_by=actor,
    )
    session.add(transaction)
    session.flush()
    for account, draft, amount, base_amount in validated:
        session.add(
            Posting(
                transaction_id=transaction.id,
                account_id=account.id,
                amount=amount,
                base_amount=base_amount,
                currency=account.currency,
                memo=draft.memo,
            )
        )
    session.flush()
    _audit(
        session,
        entity_type="transaction",
        entity_id=transaction.id,
        action=AuditAction.CREATE,
        actor=actor,
        after={"description": clean_description, "payload_hash": payload_hash},
    )
    session.refresh(transaction, attribute_names=["postings"])
    return transaction, True


def account_balance(session: Session, account_id: str, *, as_of: datetime | None = None) -> Decimal:
    query = (
        select(func.coalesce(func.sum(Posting.amount), 0))
        .join(LedgerTransaction, LedgerTransaction.id == Posting.transaction_id)
        .where(Posting.account_id == account_id)
    )
    if as_of is not None:
        query = query.where(LedgerTransaction.occurred_at <= ensure_utc(as_of))
    return money(session.scalar(query) or ZERO)


def opening_balance(
    session: Session,
    *,
    account_id: str,
    amount: Decimal,
    occurred_at: datetime,
    description: str = "期初餘額",
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    account = require_account(session, account_id)
    value = positive_money(amount)
    equity = system_account(session, AccountSubtype.OPENING_BALANCE)
    if account.kind is AccountKind.ASSET:
        signed = value
    elif account.kind is AccountKind.LIABILITY:
        signed = -value
    else:
        raise ValidationError("期初餘額只適用資產或負債帳戶")
    return create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=[
            PostingDraft(account.id, signed, signed),
            PostingDraft(equity.id, -signed, -signed),
        ],
        idempotency_key=idempotency_key,
        actor=actor,
    )


def record_expense(
    session: Session,
    *,
    payment_account_id: str,
    amount: Decimal,
    occurred_at: datetime,
    description: str,
    expense_account_id: str | None = None,
    source: str = "manual",
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    payment = require_account(session, payment_account_id)
    if payment.kind not in {AccountKind.ASSET, AccountKind.LIABILITY}:
        raise ValidationError("付款來源必須是資產或負債帳戶")
    expense = (
        require_account(session, expense_account_id)
        if expense_account_id
        else system_account(session, AccountSubtype.GENERAL_EXPENSE)
    )
    if expense.kind is not AccountKind.EXPENSE:
        raise ValidationError("支出分類必須是費用帳戶")
    value = positive_money(amount)
    return create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=[
            PostingDraft(expense.id, value, value),
            PostingDraft(payment.id, -value, -value),
        ],
        source=source,
        idempotency_key=idempotency_key,
        actor=actor,
    )


def record_income(
    session: Session,
    *,
    destination_account_id: str,
    amount: Decimal,
    occurred_at: datetime,
    description: str,
    income_account_id: str | None = None,
    source: str = "manual",
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    destination = require_account(session, destination_account_id)
    if destination.kind is not AccountKind.ASSET:
        raise ValidationError("收入目的地必須是資產帳戶")
    income = (
        require_account(session, income_account_id)
        if income_account_id
        else system_account(session, AccountSubtype.SALARY)
    )
    if income.kind is not AccountKind.INCOME:
        raise ValidationError("收入分類必須是收入帳戶")
    value = positive_money(amount)
    return create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=[
            PostingDraft(destination.id, value, value),
            PostingDraft(income.id, -value, -value),
        ],
        source=source,
        idempotency_key=idempotency_key,
        actor=actor,
    )


def record_transfer(
    session: Session,
    *,
    from_account_id: str,
    to_account_id: str,
    amount: Decimal,
    occurred_at: datetime,
    description: str,
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    source = require_account(session, from_account_id)
    destination = require_account(session, to_account_id)
    if source.id == destination.id:
        raise ValidationError("轉出與轉入帳戶不可相同")
    if source.kind is not AccountKind.ASSET or destination.kind is not AccountKind.ASSET:
        raise ValidationError("一般轉帳只適用資產帳戶")
    value = positive_money(amount)
    if account_balance(session, source.id) < value:
        raise ValidationError("轉出帳戶餘額不足")
    return create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=[
            PostingDraft(source.id, -value, -value),
            PostingDraft(destination.id, value, value),
        ],
        idempotency_key=idempotency_key,
        actor=actor,
    )


def pay_credit_card(
    session: Session,
    *,
    bank_account_id: str,
    card_account_id: str,
    amount: Decimal,
    occurred_at: datetime,
    description: str,
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    bank = require_account(session, bank_account_id)
    card = require_account(session, card_account_id)
    if bank.kind is not AccountKind.ASSET or not bank.is_liquid:
        raise ValidationError("繳款來源必須是流動資產帳戶")
    if card.kind is not AccountKind.LIABILITY or card.subtype is not AccountSubtype.CREDIT_CARD:
        raise ValidationError("繳款目的地必須是信用卡負債帳戶")
    value = positive_money(amount)
    debt = max(-account_balance(session, card.id), ZERO)
    if value > debt:
        raise ValidationError("繳款金額不可大於目前信用卡負債", details={"debt": str(debt)})
    if account_balance(session, bank.id) < value:
        raise ValidationError("繳款帳戶餘額不足")
    return create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=[
            PostingDraft(bank.id, -value, -value),
            PostingDraft(card.id, value, value),
        ],
        idempotency_key=idempotency_key,
        actor=actor,
    )


def reverse_transaction(
    session: Session,
    *,
    transaction_id: str,
    reason: str,
    occurred_at: datetime | None = None,
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    original = session.scalar(
        select(LedgerTransaction)
        .options(selectinload(LedgerTransaction.postings), selectinload(LedgerTransaction.trade))
        .where(LedgerTransaction.id == transaction_id)
    )
    if original is None:
        raise NotFoundError("找不到原始交易")
    if original.status is TransactionStatus.REVERSED:
        raise ConflictError("交易已沖銷")
    if original.trade is not None:
        raise ValidationError("第一版不允許直接沖銷投資交易，請建立反向買賣")
    clean_reason = reason.strip()
    if not clean_reason:
        raise ValidationError("沖銷原因不可為空")
    reversal, created = create_transaction(
        session,
        occurred_at=occurred_at or utc_now(),
        description=f"沖銷：{original.description}",
        postings=[
            PostingDraft(
                posting.account_id,
                -posting.amount,
                -posting.base_amount,
                posting.currency,
                f"沖銷 {original.id}",
            )
            for posting in original.postings
        ],
        source="reversal",
        idempotency_key=idempotency_key,
        actor=actor,
        reversal_of_id=original.id,
    )
    if created:
        original.status = TransactionStatus.REVERSED
        _audit(
            session,
            entity_type="transaction",
            entity_id=original.id,
            action=AuditAction.REVERSE,
            actor=actor,
            before={"status": TransactionStatus.POSTED.value},
            after={"status": TransactionStatus.REVERSED.value, "reversal_id": reversal.id},
            reason=clean_reason,
        )
    return reversal, created
