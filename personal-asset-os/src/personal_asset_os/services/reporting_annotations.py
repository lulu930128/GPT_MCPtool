from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AuditAction
from personal_asset_os.errors import ConflictError, NotFoundError, ValidationError
from personal_asset_os.models import (
    AuditLog,
    FinancialEvent,
    FinancialEventTransactionLink,
    LedgerTransaction,
    TransactionReportingAnnotation,
)
from personal_asset_os.temporal import utc_now


@dataclass(frozen=True)
class ReportingMetadata:
    category: str | None
    note: str | None
    merchant: str | None
    category_source: str | None


def _clean_required(value: str, *, field: str, max_length: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValidationError(f"{field}不可為空白")
    if len(cleaned) > max_length:
        raise ValidationError(f"{field}不可超過 {max_length} 個字元")
    return cleaned


def _clean_optional(value: str | None, *, field: str, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > max_length:
        raise ValidationError(f"{field}不可超過 {max_length} 個字元")
    return cleaned


def annotation_payload(annotation: TransactionReportingAnnotation) -> dict[str, object]:
    return {
        "id": annotation.id,
        "transaction_id": annotation.transaction_id,
        "category": annotation.category,
        "note": annotation.note,
        "version": annotation.version,
        "actor": annotation.actor,
        "created_at": annotation.created_at,
        "updated_at": annotation.updated_at,
    }


def set_annotation(
    session: Session,
    *,
    transaction_id: str,
    category: str,
    note: str | None,
    expected_version: int,
    reason: str,
    actor: str = "local_user",
) -> tuple[TransactionReportingAnnotation, bool]:
    if session.get(LedgerTransaction, transaction_id) is None:
        raise NotFoundError("找不到指定交易")

    clean_category = _clean_required(category, field="分類", max_length=120)
    clean_note = _clean_optional(note, field="備註", max_length=500)
    clean_reason = _clean_required(reason, field="修正原因", max_length=240)
    clean_actor = _clean_required(actor, field="操作者", max_length=80)
    existing = session.scalar(
        select(TransactionReportingAnnotation).where(
            TransactionReportingAnnotation.transaction_id == transaction_id
        )
    )

    if existing is None:
        if expected_version != 0:
            raise ConflictError(
                "報表註記版本衝突",
                details={"expected_version": expected_version, "actual_version": 0},
            )
        annotation = TransactionReportingAnnotation(
            transaction_id=transaction_id,
            category=clean_category,
            note=clean_note,
            version=1,
            actor=clean_actor,
        )
        session.add(annotation)
        session.flush()
        after = annotation_payload(annotation)
        session.add(
            AuditLog(
                entity_type="transaction_reporting_annotation",
                entity_id=annotation.id,
                action=AuditAction.CREATE,
                before_json=None,
                after_json=json.dumps(after, ensure_ascii=False, default=str),
                actor=clean_actor,
                reason=clean_reason,
            )
        )
        session.flush()
        return annotation, True

    if existing.version != expected_version:
        raise ConflictError(
            "報表註記版本衝突",
            details={
                "expected_version": expected_version,
                "actual_version": existing.version,
            },
        )
    if existing.category == clean_category and existing.note == clean_note:
        return existing, False

    before = annotation_payload(existing)
    existing.category = clean_category
    existing.note = clean_note
    existing.version += 1
    existing.actor = clean_actor
    existing.updated_at = utc_now()
    session.flush()
    session.add(
        AuditLog(
            entity_type="transaction_reporting_annotation",
            entity_id=existing.id,
            action=AuditAction.UPDATE,
            before_json=json.dumps(before, ensure_ascii=False, default=str),
            after_json=json.dumps(
                annotation_payload(existing), ensure_ascii=False, default=str
            ),
            actor=clean_actor,
            reason=clean_reason,
        )
    )
    session.flush()
    return existing, True


def metadata_by_transaction(
    session: Session,
    transaction_ids: set[str],
) -> dict[str, ReportingMetadata]:
    if not transaction_ids:
        return {}

    events: dict[str, tuple[str | None, str | None, str | None, str]] = {}
    annotations: dict[str, TransactionReportingAnnotation] = {}
    ordered_ids = sorted(transaction_ids)
    for offset in range(0, len(ordered_ids), 400):
        id_batch = ordered_ids[offset : offset + 400]
        for transaction_id, category, merchant, note, description in session.execute(
            select(
                FinancialEventTransactionLink.transaction_id,
                FinancialEvent.category_hint,
                FinancialEvent.merchant,
                FinancialEvent.note,
                FinancialEvent.description,
            )
            .join(FinancialEvent, FinancialEvent.id == FinancialEventTransactionLink.event_id)
            .where(FinancialEventTransactionLink.transaction_id.in_(id_batch))
            .order_by(
                FinancialEventTransactionLink.created_at,
                FinancialEventTransactionLink.id,
            )
        ):
            events.setdefault(
                str(transaction_id),
                (category, merchant, note, description),
            )
        for item in session.scalars(
            select(TransactionReportingAnnotation).where(
                TransactionReportingAnnotation.transaction_id.in_(id_batch)
            )
        ):
            annotations[item.transaction_id] = item
    result: dict[str, ReportingMetadata] = {}
    for transaction_id in transaction_ids:
        event_category, merchant, event_note, event_description = events.get(
            transaction_id, (None, None, None, "")
        )
        annotation = annotations.get(transaction_id)
        if annotation is not None:
            result[transaction_id] = ReportingMetadata(
                category=annotation.category,
                note=annotation.note,
                merchant=merchant,
                category_source="reporting_annotation",
            )
            continue
        clean_category = event_category.strip() if event_category else None
        clean_note = event_note.strip() if event_note else None
        if clean_note is None and clean_category and event_description.strip() != clean_category:
            clean_note = event_description.strip() or None
        result[transaction_id] = ReportingMetadata(
            category=clean_category,
            note=clean_note,
            merchant=merchant.strip() if merchant else None,
            category_source="category_hint" if clean_category else None,
        )
    return result
