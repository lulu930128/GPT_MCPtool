from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from personal_asset_os.domain.enums import (
    ApprovalSource,
    AuditAction,
    FinancialEventKind,
    FinancialEventStatus,
)
from personal_asset_os.errors import (
    ConflictError,
    NotFoundError,
    UnsafeOperationError,
    ValidationError,
)
from personal_asset_os.models import (
    AuditLog,
    FinancialEvent,
    FinancialEventTransactionLink,
    LedgerTransaction,
)
from personal_asset_os.services import ledger
from personal_asset_os.temporal import ensure_utc, utc_now

EDITABLE_FIELDS = frozenset(
    {
        "event_kind",
        "occurred_at",
        "amount",
        "description",
        "merchant",
        "note",
        "category_hint",
        "payment_hint",
    }
)
EDITABLE_STATUSES = {FinancialEventStatus.PENDING_MATCH, FinancialEventStatus.NEEDS_REVIEW}
CAPTURE_SOURCES = {"local_ui", "local_cli", "import", "mobile_sync", "proposal"}


def _clean_required(value: object, *, label: str, max_length: int) -> str:
    clean = str(value).strip()
    if not clean:
        raise ValidationError(f"{label}不可為空")
    if len(clean) > max_length:
        raise ValidationError(f"{label}不可超過 {max_length} 個字元")
    return clean


def _clean_optional(value: object, *, label: str, max_length: int) -> str | None:
    if value is None:
        return None
    clean = str(value).strip()
    if not clean:
        return None
    if len(clean) > max_length:
        raise ValidationError(f"{label}不可超過 {max_length} 個字元")
    return clean


def _event_document(values: Mapping[str, object]) -> dict[str, object]:
    occurred_at = cast(datetime, values["occurred_at"])
    kind = cast(FinancialEventKind, values["event_kind"])
    amount = ledger.positive_money(cast(Decimal, values["amount"]))
    return {
        "event_kind": kind.value,
        "occurred_at": ensure_utc(occurred_at).isoformat(),
        "amount": str(amount),
        "currency": str(values["currency"]).upper(),
        "description": values["description"],
        "merchant": values.get("merchant"),
        "note": values.get("note"),
        "category_hint": values.get("category_hint"),
        "payment_hint": values.get("payment_hint"),
        "source": values["source"],
        "source_reference": values.get("source_reference"),
        "device_id": values.get("device_id"),
        "local_sequence": values.get("local_sequence"),
    }


def _event_values(event: FinancialEvent) -> dict[str, object]:
    return {
        "event_kind": event.event_kind,
        "occurred_at": event.occurred_at,
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
    }


def _hash(document: Mapping[str, object]) -> str:
    encoded = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _audit(
    session: Session,
    *,
    event: FinancialEvent,
    action: AuditAction,
    actor: str,
    before: Mapping[str, object] | None = None,
    after: Mapping[str, object] | None = None,
    reason: str | None = None,
) -> None:
    session.add(
        AuditLog(
            entity_type="financial_event",
            entity_id=event.id,
            action=action,
            actor=actor,
            before_json=(
                json.dumps(before, ensure_ascii=False, sort_keys=True)
                if before is not None
                else None
            ),
            after_json=(
                json.dumps(after, ensure_ascii=False, sort_keys=True) if after is not None else None
            ),
            reason=reason,
        )
    )


def _require_event(session: Session, event_id: str) -> FinancialEvent:
    event = session.scalar(
        select(FinancialEvent)
        .options(selectinload(FinancialEvent.transaction_links))
        .where(FinancialEvent.id == event_id)
    )
    if event is None:
        raise NotFoundError("找不到日常記錄", details={"event_id": event_id})
    return event


def get_event(session: Session, event_id: str) -> FinancialEvent:
    return _require_event(session, event_id)


def capture_event(
    session: Session,
    *,
    event_kind: FinancialEventKind,
    occurred_at: datetime,
    amount: Decimal,
    description: str,
    idempotency_key: str,
    event_id: str | None = None,
    currency: str = "TWD",
    captured_at: datetime | None = None,
    merchant: str | None = None,
    note: str | None = None,
    category_hint: str | None = None,
    payment_hint: str | None = None,
    source: str = "local_ui",
    source_reference: str | None = None,
    device_id: str | None = None,
    local_sequence: int | None = None,
    actor: str = "local_user",
) -> tuple[FinancialEvent, bool]:
    clean_source = _clean_required(source, label="來源", max_length=40)
    if clean_source not in CAPTURE_SOURCES:
        raise ValidationError("不支援的日常記錄來源")
    clean_currency = currency.strip().upper()
    if clean_currency != "TWD":
        raise ValidationError("第一個垂直切片只支援 TWD 日常記錄")
    if local_sequence is not None and local_sequence < 0:
        raise ValidationError("local_sequence 不可小於零")
    key = _clean_required(idempotency_key, label="idempotency key", max_length=120)
    if len(key) < 8:
        raise ValidationError("idempotency key 至少需要 8 個字元")

    values: dict[str, object] = {
        "event_kind": event_kind,
        "occurred_at": ensure_utc(occurred_at),
        "amount": ledger.positive_money(amount),
        "currency": clean_currency,
        "description": _clean_required(description, label="描述", max_length=240),
        "merchant": _clean_optional(merchant, label="店家", max_length=120),
        "note": _clean_optional(note, label="備註", max_length=500),
        "category_hint": _clean_optional(category_hint, label="分類提示", max_length=120),
        "payment_hint": _clean_optional(payment_hint, label="付款提示", max_length=120),
        "source": clean_source,
        "source_reference": _clean_optional(
            source_reference, label="來源參照", max_length=120
        ),
        "device_id": _clean_optional(device_id, label="裝置 ID", max_length=80),
        "local_sequence": local_sequence,
    }
    payload_hash = _hash(_event_document(values))
    existing = session.scalar(
        select(FinancialEvent)
        .options(selectinload(FinancialEvent.transaction_links))
        .where(FinancialEvent.idempotency_key == key)
    )
    if existing is not None:
        if existing.ingest_payload_hash != payload_hash:
            raise ConflictError("相同 idempotency key 對應不同日常記錄內容")
        return existing, False
    if event_id is not None:
        existing_id = session.get(FinancialEvent, event_id)
        if existing_id is not None:
            raise ConflictError("Financial Event ID 已存在", details={"event_id": event_id})

    event = FinancialEvent(
        id=event_id,
        captured_at=ensure_utc(captured_at or utc_now()),
        status=FinancialEventStatus.PENDING_MATCH,
        version=1,
        idempotency_key=key,
        ingest_payload_hash=payload_hash,
        payload_hash=payload_hash,
        updated_at=utc_now(),
        **values,
    )
    session.add(event)
    session.flush()
    _audit(
        session,
        event=event,
        action=AuditAction.CREATE,
        actor=actor,
        after={
            "status": event.status.value,
            "version": event.version,
            "payload_hash": payload_hash,
        },
    )
    return event, True


def list_events(
    session: Session,
    *,
    statuses: Sequence[FinancialEventStatus] | None = None,
    limit: int = 100,
) -> list[FinancialEvent]:
    if limit < 1 or limit > 200:
        raise ValidationError("limit 必須介於 1 與 200")
    query = select(FinancialEvent).options(selectinload(FinancialEvent.transaction_links))
    if statuses:
        query = query.where(FinancialEvent.status.in_(statuses))
    query = query.order_by(
        FinancialEvent.occurred_at.desc(), FinancialEvent.created_at.desc()
    ).limit(
        limit,
    )
    return list(session.scalars(query))


def update_pending_event(
    session: Session,
    *,
    event_id: str,
    expected_version: int,
    patch: Mapping[str, object],
    actor: str = "local_user",
) -> FinancialEvent:
    event = _require_event(session, event_id)
    if event.status not in EDITABLE_STATUSES:
        raise ConflictError("只有待處理的日常記錄可以修改")
    if event.version != expected_version:
        raise ConflictError(
            "日常記錄已被更新，請重新載入",
            details={"expected_version": expected_version, "actual_version": event.version},
        )
    unknown = set(patch) - EDITABLE_FIELDS
    if unknown:
        raise ValidationError("包含不可修改的欄位", details={"fields": sorted(unknown)})
    if not patch:
        raise ValidationError("至少需要一個修改欄位")

    before = {
        "version": event.version,
        "payload_hash": event.payload_hash,
        "status": event.status.value,
    }
    for field, value in patch.items():
        if field == "event_kind":
            event.event_kind = cast(FinancialEventKind, value)
        elif field == "occurred_at":
            event.occurred_at = ensure_utc(cast(datetime, value))
        elif field == "amount":
            event.amount = ledger.positive_money(cast(Decimal, value))
        elif field == "description":
            event.description = _clean_required(value, label="描述", max_length=240)
        elif field == "merchant":
            event.merchant = _clean_optional(value, label="店家", max_length=120)
        elif field == "note":
            event.note = _clean_optional(value, label="備註", max_length=500)
        elif field == "category_hint":
            event.category_hint = _clean_optional(value, label="分類提示", max_length=120)
        elif field == "payment_hint":
            event.payment_hint = _clean_optional(value, label="付款提示", max_length=120)
    event.payload_hash = _hash(_event_document(_event_values(event)))
    event.version += 1
    event.updated_at = utc_now()
    session.flush()
    _audit(
        session,
        event=event,
        action=AuditAction.UPDATE,
        actor=actor,
        before=before,
        after={
            "version": event.version,
            "payload_hash": event.payload_hash,
            "status": event.status.value,
        },
    )
    return event


def reject_pending_event(
    session: Session,
    *,
    event_id: str,
    expected_version: int,
    reason: str,
    actor: str = "local_user",
) -> tuple[FinancialEvent, bool]:
    event = _require_event(session, event_id)
    clean_reason = _clean_required(reason, label="拒絕原因", max_length=240)
    if event.status is FinancialEventStatus.REJECTED:
        if event.rejected_reason == clean_reason:
            return event, False
        raise ConflictError("日常記錄已被拒絕，且原因不同")
    if event.status not in EDITABLE_STATUSES:
        raise ConflictError("這筆日常記錄不能拒絕")
    if event.version != expected_version:
        raise ConflictError(
            "日常記錄已被更新，請重新載入",
            details={"expected_version": expected_version, "actual_version": event.version},
        )
    before = {"status": event.status.value, "version": event.version}
    event.status = FinancialEventStatus.REJECTED
    event.version += 1
    event.rejected_reason = clean_reason
    event.rejected_at = utc_now()
    event.updated_at = utc_now()
    session.flush()
    _audit(
        session,
        event=event,
        action=AuditAction.REJECT,
        actor=actor,
        before=before,
        after={"status": event.status.value, "version": event.version},
        reason=clean_reason,
    )
    return event, True


def _linked_transaction(session: Session, event: FinancialEvent) -> LedgerTransaction | None:
    if not event.transaction_links:
        return None
    return session.scalar(
        select(LedgerTransaction)
        .options(selectinload(LedgerTransaction.postings))
        .where(LedgerTransaction.id == event.transaction_links[0].transaction_id)
    )


def finalize_event(
    session: Session,
    *,
    event_id: str,
    expected_version: int,
    payment_account_id: str | None = None,
    destination_account_id: str | None = None,
    approval_source: ApprovalSource = ApprovalSource.LOCAL_UI,
    actor: str = "local_user",
) -> tuple[FinancialEvent, LedgerTransaction, bool]:
    event = _require_event(session, event_id)
    if approval_source is ApprovalSource.PAIRED_MOBILE:
        raise UnsafeOperationError("paired-mobile 驗證器尚未啟用，不能偽裝手機核准")

    decision = {
        "event_id": event.id,
        "payload_hash": event.payload_hash,
        "event_kind": event.event_kind.value,
        "payment_account_id": payment_account_id,
        "destination_account_id": destination_account_id,
        "approval_source": approval_source.value,
    }
    finalization_hash = _hash(decision)
    if event.status is FinancialEventStatus.MATCHED:
        transaction = _linked_transaction(session, event)
        if transaction is None:
            raise ConflictError("日常記錄已完成但缺少正式交易關聯")
        if event.finalization_hash != finalization_hash:
            raise ConflictError("日常記錄已使用不同的入帳決策完成")
        return event, transaction, False
    if event.status not in EDITABLE_STATUSES:
        raise ConflictError("這筆日常記錄目前不能入帳")
    if event.version != expected_version:
        raise ConflictError(
            "日常記錄已被更新，請重新載入",
            details={"expected_version": expected_version, "actual_version": event.version},
        )

    ledger_key = f"financial-event-finalize:{event.id}"
    if event.event_kind is FinancialEventKind.EXPENSE:
        if not payment_account_id or destination_account_id:
            raise ValidationError("支出入帳需要且只能指定付款帳戶")
        transaction, _ = ledger.record_expense(
            session,
            payment_account_id=payment_account_id,
            amount=event.amount,
            occurred_at=event.occurred_at,
            description=event.description,
            source="financial_event",
            idempotency_key=ledger_key,
            actor=actor,
        )
    elif event.event_kind is FinancialEventKind.INCOME:
        if not destination_account_id or payment_account_id:
            raise ValidationError("收入入帳需要且只能指定收款帳戶")
        transaction, _ = ledger.record_income(
            session,
            destination_account_id=destination_account_id,
            amount=event.amount,
            occurred_at=event.occurred_at,
            description=event.description,
            source="financial_event",
            idempotency_key=ledger_key,
            actor=actor,
        )
    else:
        raise UnsafeOperationError("第一個垂直切片只允許一般支出與收入直接入帳")

    session.add(
        FinancialEventTransactionLink(
            event_id=event.id,
            transaction_id=transaction.id,
            relation_type="finalized",
            allocated_amount=event.amount,
            currency=event.currency,
        )
    )
    before = {"status": event.status.value, "version": event.version}
    now = utc_now()
    event.status = FinancialEventStatus.MATCHED
    event.version += 1
    event.finalization_hash = finalization_hash
    event.approval_source = approval_source
    event.approved_by = actor
    event.approved_at = now
    event.matched_at = now
    event.updated_at = now
    session.flush()
    session.refresh(event, attribute_names=["transaction_links"])
    _audit(
        session,
        event=event,
        action=AuditAction.FINALIZE,
        actor=actor,
        before=before,
        after={
            "status": event.status.value,
            "version": event.version,
            "transaction_id": transaction.id,
            "approval_source": approval_source.value,
        },
    )
    return event, transaction, True
