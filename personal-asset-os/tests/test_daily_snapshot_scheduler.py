from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from personal_asset_os.app import create_app
from personal_asset_os.database import Database
from personal_asset_os.models import DailyValuationSnapshot
from personal_asset_os.services.broker_read import BrokerReadResult
from personal_asset_os.services.daily_snapshot_scheduler import (
    capture_due_daily_snapshot,
    run_daily_snapshot_loop,
)
from personal_asset_os.services.fx_rates import OfficialUsdTwdRateProvider
from personal_asset_os.settings import Settings
from tests.broker_helpers import FakeBrokerReader, broker_result


def scheduler_settings(data_dir: Path, *, local_time: str = "06:30") -> Settings:
    return Settings(
        _env_file=None,
        data_dir=data_dir,
        broker_bridge_enabled=False,
        fx_enabled=False,
        daily_snapshot_enabled=True,
        daily_snapshot_local_time=local_time,
    )


def test_daily_snapshot_time_rejects_seconds(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="PAOS_DAILY_SNAPSHOT_LOCAL_TIME"):
        scheduler_settings(tmp_path / "paos-data", local_time="06:30:01")


def test_daily_snapshot_scheduler_waits_until_due_and_captures_only_once(
    database: Database,
    settings: Settings,
) -> None:
    resolved = scheduler_settings(settings.data_dir)
    before_due = datetime(2026, 8, 21, 22, 0, tzinfo=UTC)
    after_due = datetime(2026, 8, 21, 22, 31, tzinfo=UTC)
    reader = FakeBrokerReader(broker_result(as_of=after_due))
    fx_reader = OfficialUsdTwdRateProvider(resolved)

    waiting = capture_due_daily_snapshot(
        database,
        settings=resolved,
        broker_reader=reader,
        fx_reader=fx_reader,
        now=before_due,
    )
    created = capture_due_daily_snapshot(
        database,
        settings=resolved,
        broker_reader=reader,
        fx_reader=fx_reader,
        now=after_due,
    )
    repeated = capture_due_daily_snapshot(
        database,
        settings=resolved,
        broker_reader=reader,
        fx_reader=fx_reader,
        now=after_due,
    )

    assert waiting.status == "not_due"
    assert created.status == "created"
    assert created.snapshot_date == "2026-08-22"
    assert repeated.status == "already_captured"
    assert reader.calls == 1
    with database.session() as session:
        assert session.scalar(select(func.count()).select_from(DailyValuationSnapshot)) == 1


def test_daily_snapshot_scheduler_can_be_disabled(
    database: Database,
    settings: Settings,
) -> None:
    reader = FakeBrokerReader(broker_result(as_of=datetime(2026, 8, 22, tzinfo=UTC)))
    result = capture_due_daily_snapshot(
        database,
        settings=settings,
        broker_reader=reader,
        fx_reader=OfficialUsdTwdRateProvider(settings),
        now=datetime(2026, 8, 22, 12, tzinfo=UTC),
    )

    assert result.status == "disabled"
    assert reader.calls == 0


def test_app_lifespan_runs_first_ready_catch_up(tmp_path: Path) -> None:
    resolved = scheduler_settings(tmp_path / "paos-data", local_time="00:00")
    now = datetime.now(UTC)
    reader = FakeBrokerReader(broker_result(as_of=now))
    app = create_app(resolved, broker_reader=reader)

    with TestClient(app) as client:
        history: dict[str, object] = {}
        for _ in range(100):
            response = client.get("/api/dashboard/history?range=1m")
            history = response.json()
            if history["coverage"]["point_count"] == 1:  # type: ignore[index]
                break
            time.sleep(0.01)

    assert history["coverage"]["point_count"] == 1  # type: ignore[index]
    assert reader.calls == 1


def test_daily_snapshot_loop_retries_after_transient_failure(tmp_path: Path) -> None:
    resolved = scheduler_settings(tmp_path / "paos-data", local_time="00:00")
    app = create_app(
        resolved.model_copy(update={"daily_snapshot_enabled": False})
    )
    database: Database = app.state.database
    captured_at = datetime(2026, 8, 22, 12, tzinfo=UTC)
    successful = broker_result(as_of=captured_at)

    class FlakyReader:
        def __init__(self) -> None:
            self.calls = 0

        def read(self, *, now: datetime | None = None) -> BrokerReadResult:
            del now
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("temporary bridge failure")
            return successful

    reader = FlakyReader()

    async def exercise() -> None:
        stop_event = asyncio.Event()
        task = asyncio.create_task(
            run_daily_snapshot_loop(
                database,
                settings=resolved,
                broker_reader=reader,
                fx_reader=OfficialUsdTwdRateProvider(resolved),
                stop_event=stop_event,
                poll_seconds=0.01,
                now_provider=lambda: captured_at,
            )
        )
        for _ in range(100):
            with database.session() as session:
                count = session.scalar(
                    select(func.count()).select_from(DailyValuationSnapshot)
                )
            if count == 1:
                break
            await asyncio.sleep(0.01)
        stop_event.set()
        await asyncio.wait_for(task, timeout=1)

    try:
        asyncio.run(exercise())
        assert reader.calls == 2
    finally:
        database.engine.dispose()
