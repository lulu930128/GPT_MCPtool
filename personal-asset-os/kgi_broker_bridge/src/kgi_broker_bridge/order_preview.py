"""Offline fixed-order contract. No SDK loader, session, or send implementation."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kgi_broker_bridge.settings import Settings


class OfflineSettings(BaseModel):
    """Reuse Settings conventions, but accept explicit arguments only; no secrets."""

    # Settings() constructs env/dotenv sources even when later filtered out.
    # Reuse its production-session default without ever constructing BaseSettings.
    model_config = ConfigDict(extra="forbid", frozen=True)
    simulation: Literal[False] = Settings.model_fields["simulation"].default
    mode: Literal["PREVIEW"] = "PREVIEW"


class State(StrEnum):
    PREVIEW = "PREVIEW"
    NOT_SENT = "NOT_SENT"
    UNKNOWN = "UNKNOWN"
    BROKER_ACCEPTED = "BROKER_ACCEPTED"
    FILLED = "FILLED"


class FixedOrder(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    symbol: Literal["2330"] = "2330"
    action: Literal["BUY"] = "BUY"
    price: Decimal = Decimal("2160")
    quantity_shares: int = Field(default=1, strict=True, ge=1, le=1)
    price_type: Literal["LIMIT"] = "LIMIT"
    odd_lot: Literal["OddLot.Odd"] = "OddLot.Odd"
    time_in_force: Literal["ROD"] = "ROD"
    order_cond: Literal["CASH"] = "CASH"

    @field_validator("price")
    @classmethod
    def fixed_price(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value != Decimal("2160"):
            raise ValueError("price_outside_fixed_scope")
        return Decimal("2160")

    def fingerprint(self) -> str:
        # Revalidate even model_construct/model_copy objects at the boundary.
        checked = FixedOrder.model_validate(self.model_dump())
        canonical = json.dumps(
            checked.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def sdk_arguments(order: FixedOrder, enums: Any) -> dict[str, object]:
    """Pure mapping to 2.1.0 enums; never calls Order.create_order (which sends)."""
    order.fingerprint()
    return {
        "action": enums.Action.Buy,
        "symbol": order.symbol,
        "qty": order.quantity_shares,
        # This fixed integral price is exactly representable; do not generalize to float.
        "price": int(order.price),
        "time_in_force": enums.TimeInForce.ROD,
        "order_cond": enums.OrderCond.CASH,
        "odd_lot": enums.OddLot.Odd,
        "name": "",
    }


def preview(settings: OfflineSettings, order: FixedOrder) -> dict[str, object]:
    fingerprint = order.fingerprint()
    return {
        "schema": "kgi.order.preview.v1",
        "mode": settings.mode,
        "state": State.PREVIEW.value,
        "submission_state": State.NOT_SENT.value,
        "evidence": "OFFLINE_PREVIEW",
        "created_at": datetime.now(UTC).isoformat(),
        "intent_sha256": fingerprint,
        "order": order.model_dump(mode="json"),
        "sdk_contract": "kgisuperpy 2.1.0 Order.create_order",
        "sdk_arguments": {
            "action": "Action.Buy", "symbol": "2330", "qty": 1, "price": 2160,
            "time_in_force": "TimeInForce.ROD", "order_cond": "OrderCond.CASH",
            "odd_lot": "OddLot.Odd", "name": "",
        },
        "account": "NOT_SELECTED",
        "session_plan": {
            "simulation": settings.simulation,
            "sequence": ["login", "select_securities_account", "set_Account", "logout"],
            "performed": False,
        },
        "sdk_imported": False,
        "login_attempted": False,
        "send_attempted": False,
        "native_sdk": "UNVERIFIED",
        "ca": "UNVERIFIED",
        "broker_receipt": "UNVERIFIED",
    }


class OfflineConflict(Exception):
    """Fixed, sanitized error codes only."""


class SyntheticReceipt(BaseModel):
    """Normalized fake evidence, deliberately not a vendor-response parser."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)
    evidence: Literal["SYNTHETIC"] = "SYNTHETIC"
    account: Literal["SYNTHETIC-STOCK"] = "SYNTHETIC-STOCK"
    intent_sha256: str
    attempt_id: str = Field(pattern=r"^fake-[a-z0-9-]{1,64}$")
    broker_order_id: str = Field(pattern=r"^fake-order-[a-z0-9-]{1,64}$")
    state: Literal[State.BROKER_ACCEPTED, State.FILLED]
    filled_shares: int = Field(default=0, strict=True, ge=0, le=1)


@dataclass(frozen=True)
class SyntheticAttempt:
    """Owned by one test worker; immutable claim fences even different request IDs.

    The directory is explicitly supplied by tests, never a PAOS runtime directory.
    A claim is never removed or retried. A crash before receipt leaves UNKNOWN.
    """

    directory: Path
    intent_sha256: str
    attempt_id: str

    @classmethod
    def claim(
        cls, directory: Path, order: FixedOrder, attempt_id: str,
        *, existing_orders: tuple[SyntheticReceipt, ...] | None,
    ) -> SyntheticAttempt:
        fingerprint = order.fingerprint()
        # Only a test-supplied, explicitly empty snapshot permits a first fake attempt.
        # Missing/ambiguous/existing orders require reconciliation, never a new send.
        if existing_orders is None:
            raise OfflineConflict("existing_orders_unknown")
        if existing_orders != ():
            raise OfflineConflict("existing_order_requires_reconciliation")
        # Validate identifiers without logging caller data.
        if not attempt_id.startswith("fake-") or not 6 <= len(attempt_id) <= 69:
            raise OfflineConflict("invalid_synthetic_attempt")
        if not all(ch in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in attempt_id):
            raise OfflineConflict("invalid_synthetic_attempt")
        directory = directory.resolve(strict=True)
        claim = directory / f"{fingerprint}.claim.json"
        try:
            # Exclusive create is the ownership boundary; never overwrite/adopt a claim.
            with claim.open("x", encoding="utf-8") as stream:
                json.dump({"evidence": "SYNTHETIC", "account": "SYNTHETIC-STOCK",
                           "intent_sha256": fingerprint, "attempt_id": attempt_id,
                           "state": State.UNKNOWN.value}, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            raise OfflineConflict("duplicate_or_unknown_attempt") from None
        return cls(directory, fingerprint, attempt_id)

    def reconcile(self, receipts: tuple[SyntheticReceipt, ...]) -> State:
        """No match, ambiguous matches, or malformed evidence never authorizes resend."""
        claim_path = self.directory / f"{self.intent_sha256}.claim.json"
        try:
            claim = json.loads(claim_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return State.UNKNOWN
        expected = {"evidence": "SYNTHETIC", "account": "SYNTHETIC-STOCK",
                    "intent_sha256": self.intent_sha256, "attempt_id": self.attempt_id,
                    "state": State.UNKNOWN.value}
        if claim != expected or len(receipts) != 1:
            return State.UNKNOWN
        receipt = receipts[0]
        try:
            receipt = SyntheticReceipt.model_validate(receipt.model_dump())
        except ValueError:
            return State.UNKNOWN
        if receipt.intent_sha256 != self.intent_sha256 or receipt.attempt_id != self.attempt_id:
            return State.UNKNOWN
        if receipt.state == State.FILLED and receipt.filled_shares == 1:
            return State.FILLED
        if receipt.state == State.BROKER_ACCEPTED and receipt.filled_shares == 0:
            return State.BROKER_ACCEPTED
        return State.UNKNOWN
