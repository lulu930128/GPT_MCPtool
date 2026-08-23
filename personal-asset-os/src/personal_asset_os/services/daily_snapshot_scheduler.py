from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from personal_asset_os.database import Database
from personal_asset_os.models import DailyValuationSnapshot
from personal_asset_os.services import reporting, valuation_history
from personal_asset_os.services.broker_read import BrokerSnapshotProvider
from personal_asset_os.services.fx_rates import FxRateProvider
from personal_asset_os.settings import Settings
from personal_asset_os.temporal import ensure_utc, utc_now

logger = logging.getLogger(__name__)

DAILY_SNAPSHOT_POLL_SECONDS = 300.0
DailySnapshotAttemptStatus = Literal[
    "disabled", "not_due", "already_captured", "created"
]


@dataclass(frozen=True, slots=True)
class DailySnapshotAttempt:
    status: DailySnapshotAttemptStatus
    snapshot_date: str
    quality: str | None = None
    broker_status: str | None = None


def capture_current_daily_snapshot(
    session: Session,
    *,
    settings: Settings,
    broker_reader: BrokerSnapshotProvider,
    fx_reader: FxRateProvider,
    captured_at: datetime | None = None,
    actor: str = "local_user",
) -> tuple[DailyValuationSnapshot, bool]:
    checked_at = ensure_utc(captured_at or utc_now())
    existing = valuation_history.find_daily_snapshot(
        session,
        as_of=checked_at,
        reporting_timezone=settings.reporting_timezone,
    )
    if existing is not None:
        return existing, False

    dashboard_view = reporting.dashboard(
        session,
        as_of=checked_at,
        broker_read=broker_reader.read(now=checked_at),
        broker_investment_account_id=settings.broker_investment_account_id,
        broker_us_investment_account_id=settings.broker_us_investment_account_id,
        fx_provider=fx_reader,
        reporting_timezone=settings.reporting_timezone,
    )
    return valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=dashboard_view,
        reporting_timezone=settings.reporting_timezone,
        actor=actor,
        captured_at=checked_at,
    )


def capture_due_daily_snapshot(
    database: Database,
    *,
    settings: Settings,
    broker_reader: BrokerSnapshotProvider,
    fx_reader: FxRateProvider,
    now: datetime | None = None,
) -> DailySnapshotAttempt:
    checked_at = ensure_utc(now or utc_now())
    local_now = checked_at.astimezone(ZoneInfo(settings.reporting_timezone))
    snapshot_date = local_now.date().isoformat()
    if not settings.daily_snapshot_enabled:
        return DailySnapshotAttempt(status="disabled", snapshot_date=snapshot_date)
    if local_now.time().replace(tzinfo=None) < settings.daily_snapshot_wall_time:
        return DailySnapshotAttempt(status="not_due", snapshot_date=snapshot_date)

    with database.session() as session:
        snapshot, created = capture_current_daily_snapshot(
            session,
            settings=settings,
            broker_reader=broker_reader,
            fx_reader=fx_reader,
            captured_at=checked_at,
            actor="system_daily_snapshot",
        )
        return DailySnapshotAttempt(
            status="created" if created else "already_captured",
            snapshot_date=snapshot.snapshot_date,
            quality=snapshot.quality,
            broker_status=snapshot.broker_status,
        )


async def run_daily_snapshot_loop(
    database: Database,
    *,
    settings: Settings,
    broker_reader: BrokerSnapshotProvider,
    fx_reader: FxRateProvider,
    stop_event: asyncio.Event,
    poll_seconds: float = DAILY_SNAPSHOT_POLL_SECONDS,
    now_provider: Callable[[], datetime] = utc_now,
) -> None:
    while not stop_event.is_set():
        try:
            attempt = await asyncio.to_thread(
                capture_due_daily_snapshot,
                database,
                settings=settings,
                broker_reader=broker_reader,
                fx_reader=fx_reader,
                now=now_provider(),
            )
            if attempt.status == "created":
                logger.info(
                    "Daily valuation snapshot created for %s (quality=%s, broker=%s)",
                    attempt.snapshot_date,
                    attempt.quality,
                    attempt.broker_status,
                )
        except Exception:
            logger.exception("Daily valuation snapshot attempt failed; it will be retried")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=poll_seconds)
        except TimeoutError:
            continue
