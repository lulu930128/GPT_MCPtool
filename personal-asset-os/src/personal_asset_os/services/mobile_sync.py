from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import FinancialEventKind
from personal_asset_os.errors import (
    AuthenticationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from personal_asset_os.models import FinancialEvent, MobileDevice, MobilePairingSession
from personal_asset_os.services import financial_events
from personal_asset_os.temporal import ensure_utc, utc_now

MOBILE_SCHEMA_VERSION = 3
SUPPORTED_MOBILE_SCHEMA_VERSIONS = frozenset({1, 2, MOBILE_SCHEMA_VERSION})
PAIRING_CODE_TTL = timedelta(minutes=10)
PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
PAIRING_CODE_LENGTH = 12
TOKEN_BYTES = 32
MOBILE_HASH_PREFIX = "mobile-sha256:"


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_pairing_code(value: str) -> str:
    normalized = "".join(character for character in value.upper() if character.isalnum())
    if len(normalized) != PAIRING_CODE_LENGTH:
        raise AuthenticationError("配對碼無效或已過期")
    return normalized


def _display_pairing_code(value: str) -> str:
    return "-".join(value[index : index + 4] for index in range(0, len(value), 4))


def _clean_device_id(value: str) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 80:
        raise ValidationError("裝置 ID 格式不正確")
    return cleaned


def _clean_display_name(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValidationError("裝置名稱不可為空")
    if len(cleaned) > 120:
        raise ValidationError("裝置名稱不可超過 120 個字元")
    return cleaned


def create_pairing_session(
    session: Session,
    *,
    ttl: timedelta = PAIRING_CODE_TTL,
) -> tuple[MobilePairingSession, str]:
    if ttl < timedelta(minutes=1) or ttl > timedelta(hours=1):
        raise ValidationError("配對碼有效時間必須介於 1 分鐘與 1 小時")
    for _ in range(8):
        raw_code = "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))
        code_hash = _hash_secret(raw_code)
        exists = session.scalar(
            select(MobilePairingSession.id).where(MobilePairingSession.code_hash == code_hash)
        )
        if exists is None:
            now = utc_now()
            pairing = MobilePairingSession(
                code_hash=code_hash,
                created_at=now,
                expires_at=now + ttl,
            )
            session.add(pairing)
            session.flush()
            return pairing, _display_pairing_code(raw_code)
    raise RuntimeError("無法產生唯一的手機配對碼")


def pair_device(
    session: Session,
    *,
    pairing_code: str,
    device_id: str,
    display_name: str,
) -> tuple[MobileDevice, str]:
    normalized_code = _normalize_pairing_code(pairing_code)
    pairing = session.scalar(
        select(MobilePairingSession).where(
            MobilePairingSession.code_hash == _hash_secret(normalized_code)
        )
    )
    now = utc_now()
    if pairing is None or pairing.used_at is not None or pairing.expires_at <= now:
        raise AuthenticationError("配對碼無效或已過期")

    clean_device_id = _clean_device_id(device_id)
    clean_name = _clean_display_name(display_name)
    token = secrets.token_urlsafe(TOKEN_BYTES)
    token_hash = _hash_secret(token)
    device = session.get(MobileDevice, clean_device_id)
    if device is None:
        device = MobileDevice(
            id=clean_device_id,
            display_name=clean_name,
            token_hash=token_hash,
            paired_at=now,
            last_accepted_sequence=0,
        )
        session.add(device)
    else:
        device.display_name = clean_name
        device.token_hash = token_hash
        device.paired_at = now
        device.revoked_at = None

    pairing.used_at = now
    pairing.paired_device_id = clean_device_id
    session.flush()
    return device, token


def authenticate_device(session: Session, token: str) -> MobileDevice:
    clean_token = token.strip()
    if len(clean_token) < 32 or len(clean_token) > 256:
        raise AuthenticationError("裝置憑證無效，請重新配對")
    token_hash = _hash_secret(clean_token)
    device = session.scalar(select(MobileDevice).where(MobileDevice.token_hash == token_hash))
    if device is None or not hmac.compare_digest(device.token_hash, token_hash):
        raise AuthenticationError("裝置憑證無效，請重新配對")
    if device.revoked_at is not None:
        raise AuthenticationError("裝置已撤銷，請重新配對")
    return device


def list_devices(session: Session) -> list[MobileDevice]:
    return list(session.scalars(select(MobileDevice).order_by(MobileDevice.paired_at.desc())))


def revoke_device(session: Session, device_id: str) -> tuple[MobileDevice, bool]:
    device = session.get(MobileDevice, _clean_device_id(device_id))
    if device is None:
        raise NotFoundError("找不到已配對裝置", details={"device_id": device_id})
    if device.revoked_at is not None:
        return device, False
    device.revoked_at = utc_now()
    session.flush()
    return device, True


def canonical_mobile_payload(payload: Mapping[str, object]) -> str:
    event_kind = payload["event_kind"]
    if isinstance(event_kind, FinancialEventKind):
        event_kind = event_kind.value
    schema_version = int(cast(int, payload["schema_version"]))
    document: dict[str, object] = {
        "schema_version": schema_version,
        "id": str(payload["id"]),
        "event_kind": event_kind,
        "occurred_at": payload["occurred_at"],
        "captured_at": payload["captured_at"],
        "amount": payload["amount"],
        "currency": payload["currency"],
        "description": payload["description"],
    }
    if schema_version >= 3:
        document["category_hint"] = payload.get("category_hint")
    document.update({
        "merchant": payload.get("merchant"),
        "note": payload.get("note"),
        "payment_hint": payload.get("payment_hint"),
        "source": payload["source"],
        "device_id": payload["device_id"],
        "local_sequence": payload["local_sequence"],
        "idempotency_key": payload["idempotency_key"],
    })
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def mobile_payload_hash(payload: Mapping[str, object]) -> str:
    encoded = canonical_mobile_payload(payload).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def capture_mobile_event(
    session: Session,
    *,
    device: MobileDevice,
    payload: Mapping[str, object],
    payload_hash: str,
) -> tuple[FinancialEvent, bool]:
    schema_version = int(cast(int, payload["schema_version"]))
    if schema_version not in SUPPORTED_MOBILE_SCHEMA_VERSIONS:
        raise ValidationError("不支援的手機 outbox schema version")
    category_hint = cast(str | None, payload.get("category_hint"))
    clean_category = category_hint.strip() if category_hint else ""
    clean_description = str(payload.get("description") or "").strip()
    if schema_version >= 3 and not clean_category:
        raise ValidationError("新版手機記錄必須提供分類")
    if schema_version < 3 and category_hint is not None:
        raise ValidationError("舊版手機記錄不支援分類欄位")
    if schema_version < 3 and not clean_description:
        raise ValidationError("舊版手機記錄必須提供描述")
    if str(payload["device_id"]) != device.id:
        raise AuthenticationError("裝置識別與憑證不一致")
    expected_hash = mobile_payload_hash(payload)
    normalized_hash = payload_hash.strip().lower()
    if not hmac.compare_digest(expected_hash, normalized_hash):
        raise ConflictError("手機 payload hash 驗證失敗")

    sequence = int(cast(int, payload["local_sequence"]))
    source_reference = f"{MOBILE_HASH_PREFIX}{expected_hash}"
    existing_sequence = session.scalar(
        select(FinancialEvent).where(
            FinancialEvent.device_id == device.id,
            FinancialEvent.local_sequence == sequence,
        )
    )
    if existing_sequence is not None:
        exact_retry = (
            existing_sequence.id == str(payload["id"])
            and existing_sequence.idempotency_key == str(payload["idempotency_key"])
            and existing_sequence.source_reference == source_reference
            and existing_sequence.source == "mobile_sync"
        )
        if not exact_retry:
            raise ConflictError(
                "相同裝置序號對應不同日常記錄內容",
                details={"device_id": device.id, "local_sequence": sequence},
            )
        device.last_seen_at = utc_now()
        device.last_accepted_sequence = max(device.last_accepted_sequence, sequence)
        return existing_sequence, False

    event, created = financial_events.capture_event(
        session,
        event_id=str(payload["id"]),
        event_kind=cast(FinancialEventKind, payload["event_kind"]),
        occurred_at=ensure_utc(
            datetime.fromisoformat(str(payload["occurred_at"]).replace("Z", "+00:00"))
        ),
        captured_at=ensure_utc(
            datetime.fromisoformat(str(payload["captured_at"]).replace("Z", "+00:00"))
        ),
        amount=Decimal(str(payload["amount"])),
        currency=str(payload["currency"]),
        description=clean_description or clean_category,
        merchant=cast(str | None, payload.get("merchant")),
        note=cast(str | None, payload.get("note")),
        category_hint=clean_category or None,
        payment_hint=cast(str | None, payload.get("payment_hint")),
        source="mobile_sync",
        source_reference=source_reference,
        device_id=device.id,
        local_sequence=sequence,
        idempotency_key=str(payload["idempotency_key"]),
        actor=f"mobile_device:{device.id}",
    )
    device.last_seen_at = utc_now()
    device.last_accepted_sequence = max(device.last_accepted_sequence, sequence)
    session.flush()
    return event, created
