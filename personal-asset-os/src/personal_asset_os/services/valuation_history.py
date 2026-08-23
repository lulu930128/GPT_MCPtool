from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal, cast
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from personal_asset_os.build import source_build_id
from personal_asset_os.domain.enums import AuditAction
from personal_asset_os.errors import ValidationError
from personal_asset_os.models import AuditLog, DailyValuationSnapshot
from personal_asset_os.services.ledger import money
from personal_asset_os.services.reporting import CALCULATION_VERSION
from personal_asset_os.temporal import ensure_utc, utc_now

HistoryRange = Literal["1m", "3m", "1y"]
HISTORY_RANGE_DAYS: dict[HistoryRange, int] = {"1m": 30, "3m": 90, "1y": 365}


def _reporting_date(value: datetime, reporting_timezone: str) -> date:
    return ensure_utc(value).astimezone(ZoneInfo(reporting_timezone)).date()


def find_daily_snapshot(
    session: Session,
    *,
    as_of: datetime,
    reporting_timezone: str,
) -> DailyValuationSnapshot | None:
    snapshot_date = _reporting_date(as_of, reporting_timezone).isoformat()
    return session.scalar(
        select(DailyValuationSnapshot).where(
            DailyValuationSnapshot.snapshot_date == snapshot_date
        )
    )


def _mapping(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValidationError(f"dashboard {field} contract 不正確")
    return cast(dict[str, object], value)


def _decimal(mapping: dict[str, object], field: str, *, nullable: bool = False) -> Decimal | None:
    value = mapping.get(field)
    if value is None and nullable:
        return None
    if isinstance(value, bool) or isinstance(value, float) or value is None:
        raise ValidationError(f"dashboard {field} 必須是 Decimal 金額")
    try:
        return money(cast(Decimal | int | str, value))
    except (ArithmeticError, TypeError, ValueError) as exc:
        raise ValidationError(f"dashboard {field} 必須是 Decimal 金額") from exc


def _nonnegative_integer(mapping: dict[str, object], field: str) -> int:
    value = mapping.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError(f"dashboard {field} 必須是非負整數")
    return value


def _optional_datetime(mapping: dict[str, object], field: str) -> datetime | None:
    value = mapping.get(field)
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise ValidationError(f"dashboard {field} 必須是 timestamp 或 null")
    return ensure_utc(value)


def _safe_timestamp_evidence(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return ensure_utc(value)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return ensure_utc(parsed)


def _safe_fx_evidence(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    fx = cast(dict[str, object], value)
    allowed = (
        "status",
        "base_currency",
        "quote_currency",
        "rate",
        "effective_at",
        "provider",
        "quality",
        "effective_precision",
    )
    evidence = {key: fx[key] for key in allowed if key in fx}
    if "effective_at" in evidence:
        evidence["effective_at"] = _safe_timestamp_evidence(evidence["effective_at"])
    return evidence


def _safe_market_evidence(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    allowed = (
        "market",
        "status",
        "source",
        "source_as_of",
        "position_count",
        "valuation_count",
        "error_code",
    )
    rows: list[dict[str, object]] = []
    for item in value:
        if isinstance(item, dict):
            market = cast(dict[str, object], item)
            evidence = {key: market[key] for key in allowed if key in market}
            if "source_as_of" in evidence:
                evidence["source_as_of"] = _safe_timestamp_evidence(
                    evidence["source_as_of"]
                )
            rows.append(evidence)
    return rows


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return ensure_utc(value).isoformat()
    raise TypeError(f"Unsupported JSON value: {type(value)!r}")


def capture_daily_snapshot(
    session: Session,
    *,
    dashboard_view: dict[str, object],
    reporting_timezone: str,
    actor: str = "local_user",
    captured_at: datetime | None = None,
) -> tuple[DailyValuationSnapshot, bool]:
    as_of_value = dashboard_view.get("as_of")
    if not isinstance(as_of_value, datetime):
        raise ValidationError("dashboard as_of contract 不正確")
    as_of = ensure_utc(as_of_value)
    existing = find_daily_snapshot(
        session,
        as_of=as_of,
        reporting_timezone=reporting_timezone,
    )
    if existing is not None:
        return existing, False

    base_currency = dashboard_view.get("base_currency")
    quality = dashboard_view.get("quality")
    if not isinstance(base_currency, str) or len(base_currency) != 3:
        raise ValidationError("dashboard base_currency contract 不正確")
    if not isinstance(quality, str) or not quality:
        raise ValidationError("dashboard quality contract 不正確")

    metrics = _mapping(dashboard_view.get("metrics"), "metrics")
    valuation = _mapping(dashboard_view.get("valuation"), "valuation")
    broker = _mapping(dashboard_view.get("broker"), "broker")
    broker_status = broker.get("status")
    if not isinstance(broker_status, str) or not broker_status:
        raise ValidationError("dashboard broker.status contract 不正確")

    warnings_value = dashboard_view.get("warnings")
    if not isinstance(warnings_value, list) or not all(
        isinstance(item, str) for item in warnings_value
    ):
        raise ValidationError("dashboard warnings contract 不正確")
    warnings = list(dict.fromkeys(cast(list[str], warnings_value)))

    price_as_of_min = _optional_datetime(valuation, "price_as_of_min")
    price_as_of_max = _optional_datetime(valuation, "price_as_of_max")
    missing_count = _nonnegative_integer(valuation, "missing_count")
    stale_count = _nonnegative_integer(valuation, "stale_count")
    broker_position_count = _nonnegative_integer(metrics, "broker_position_count")
    broker_unreconciled_count = _nonnegative_integer(
        metrics, "broker_unreconciled_count"
    )

    evidence = {
        "schema_version": 1,
        "valuation": {
            "price_as_of_min": price_as_of_min,
            "price_as_of_max": price_as_of_max,
            "missing_count": missing_count,
            "stale_count": stale_count,
            "policy": valuation.get("policy"),
        },
        "broker": {
            "status": broker_status,
            "read_mode": broker.get("read_mode"),
            "source_as_of": _safe_timestamp_evidence(broker.get("source_as_of")),
            "captured_at": _safe_timestamp_evidence(broker.get("captured_at")),
            "position_count": broker_position_count,
            "unreconciled_count": broker_unreconciled_count,
            "markets": _safe_market_evidence(broker.get("markets")),
            "fx": _safe_fx_evidence(broker.get("fx")),
        },
    }
    broker_market_value = (
        None
        if broker_status in {"disabled", "unavailable"}
        else _decimal(metrics, "broker_market_value", nullable=True)
    )
    snapshot = DailyValuationSnapshot(
        snapshot_date=_reporting_date(as_of, reporting_timezone).isoformat(),
        reporting_timezone=reporting_timezone,
        as_of=as_of,
        captured_at=ensure_utc(captured_at or utc_now()),
        base_currency=base_currency.upper(),
        quality=quality,
        provisional_net_worth=cast(Decimal, _decimal(metrics, "provisional_net_worth")),
        known_net_worth=cast(Decimal, _decimal(metrics, "known_net_worth")),
        non_investment_assets=cast(Decimal, _decimal(metrics, "non_investment_assets")),
        liquid_cash=cast(Decimal, _decimal(metrics, "liquid_cash")),
        available_cash=cast(Decimal, _decimal(metrics, "available_cash")),
        debt=cast(Decimal, _decimal(metrics, "debt")),
        investment_book_value=cast(Decimal, _decimal(metrics, "investment_book_value")),
        investment_market_value=cast(
            Decimal, _decimal(metrics, "investment_market_value")
        ),
        unpriced_investment_cost=cast(
            Decimal, _decimal(metrics, "unpriced_investment_cost")
        ),
        broker_market_value=broker_market_value,
        broker_position_count=broker_position_count,
        price_as_of_min=price_as_of_min,
        price_as_of_max=price_as_of_max,
        missing_count=missing_count,
        stale_count=stale_count,
        broker_status=broker_status,
        warnings_json=json.dumps(warnings, ensure_ascii=False),
        evidence_json=json.dumps(
            evidence,
            ensure_ascii=False,
            sort_keys=True,
            default=_json_default,
        ),
        calculation_version=f"{CALCULATION_VERSION}:{source_build_id()}",
        created_by=actor,
    )
    try:
        with session.begin_nested():
            session.add(snapshot)
            session.flush()
    except IntegrityError:
        concurrent = find_daily_snapshot(
            session,
            as_of=as_of,
            reporting_timezone=reporting_timezone,
        )
        if concurrent is None:
            raise
        return concurrent, False
    session.add(
        AuditLog(
            entity_type="daily_valuation_snapshot",
            entity_id=snapshot.id,
            action=AuditAction.SNAPSHOT,
            actor=actor,
            after_json=None,
        )
    )
    return snapshot, True


def snapshot_payload(snapshot: DailyValuationSnapshot) -> dict[str, object]:
    evidence = cast(dict[str, object], json.loads(snapshot.evidence_json))
    return {
        "id": snapshot.id,
        "date": snapshot.snapshot_date,
        "reporting_timezone": snapshot.reporting_timezone,
        "as_of": snapshot.as_of,
        "captured_at": snapshot.captured_at,
        "base_currency": snapshot.base_currency,
        "quality": snapshot.quality,
        "provisional": snapshot.quality != "complete",
        "metrics": {
            "provisional_net_worth": snapshot.provisional_net_worth,
            "known_net_worth": snapshot.known_net_worth,
            "non_investment_assets": snapshot.non_investment_assets,
            "liquid_cash": snapshot.liquid_cash,
            "available_cash": snapshot.available_cash,
            "debt": snapshot.debt,
            "investment_book_value": snapshot.investment_book_value,
            "investment_market_value": snapshot.investment_market_value,
            "unpriced_investment_cost": snapshot.unpriced_investment_cost,
            "broker_market_value": snapshot.broker_market_value,
        },
        "valuation": evidence.get("valuation", {}),
        "broker": evidence.get("broker", {}),
        "warnings": cast(list[str], json.loads(snapshot.warnings_json)),
        "calculation_version": snapshot.calculation_version,
    }


def history(
    session: Session,
    *,
    range_code: HistoryRange,
    reporting_timezone: str,
    base_currency: str,
    now: datetime | None = None,
) -> dict[str, object]:
    days = HISTORY_RANGE_DAYS[range_code]
    reference = ensure_utc(now or utc_now())
    end_date = _reporting_date(reference, reporting_timezone)
    start_date = end_date - timedelta(days=days - 1)
    rows = list(
        session.scalars(
            select(DailyValuationSnapshot)
            .where(
                DailyValuationSnapshot.snapshot_date >= start_date.isoformat(),
                DailyValuationSnapshot.snapshot_date <= end_date.isoformat(),
            )
            .order_by(DailyValuationSnapshot.snapshot_date)
        )
    )
    point_count = len(rows)
    return {
        "schema_version": 1,
        "range": range_code,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "reporting_timezone": reporting_timezone,
        "base_currency": rows[0].base_currency if rows else base_currency,
        "series": [snapshot_payload(row) for row in rows],
        "coverage": {
            "expected_calendar_days": days,
            "point_count": point_count,
            "missing_calendar_days": days - point_count,
            "first_date": rows[0].snapshot_date if rows else None,
            "last_date": rows[-1].snapshot_date if rows else None,
            "gap_policy": "missing_dates_are_omitted_not_zero_filled",
        },
    }
