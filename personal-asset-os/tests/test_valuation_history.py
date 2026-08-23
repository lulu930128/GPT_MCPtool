from __future__ import annotations

import sqlite3
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from personal_asset_os.database import Database
from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.migrations import run_migrations
from personal_asset_os.models import AuditLog, DailyValuationSnapshot
from personal_asset_os.services import ledger, reporting, valuation_history
from personal_asset_os.settings import Settings
from tests.broker_helpers import broker_result
from tests.helpers import NOW, add_account


def test_daily_snapshot_is_immutable_and_idempotent_for_reporting_date(
    session: Session,
) -> None:
    bank = add_account(
        session,
        "每日快照銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    first_view = reporting.dashboard(session, as_of=NOW)
    first, first_created = valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=first_view,
        reporting_timezone="Asia/Taipei",
        captured_at=NOW,
    )

    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("100"),
        occurred_at=NOW + timedelta(hours=1),
        description="同日後續支出",
    )
    changed_view = reporting.dashboard(session, as_of=NOW + timedelta(hours=2))
    second, second_created = valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=changed_view,
        reporting_timezone="Asia/Taipei",
        captured_at=NOW + timedelta(hours=2),
    )

    assert first_created is True
    assert second_created is False
    assert second.id == first.id
    assert second.provisional_net_worth == Decimal("1000.000000")
    assert second.broker_market_value is None
    assert session.scalar(select(func.count()).select_from(DailyValuationSnapshot)) == 1
    assert (
        session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_type == "daily_valuation_snapshot")
        )
        == 1
    )


def test_history_preserves_missing_dates_as_gaps(session: Session) -> None:
    add_account(
        session,
        "趨勢銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("2000"),
    )
    for offset in (0, 2):
        as_of = NOW + timedelta(days=offset)
        valuation_history.capture_daily_snapshot(
            session,
            dashboard_view=reporting.dashboard(session, as_of=as_of),
            reporting_timezone="Asia/Taipei",
            captured_at=as_of,
        )

    result = valuation_history.history(
        session,
        range_code="1m",
        reporting_timezone="Asia/Taipei",
        base_currency="TWD",
        now=NOW + timedelta(days=2),
    )

    assert [point["date"] for point in result["series"]] == ["2026-08-06", "2026-08-08"]  # type: ignore[index]
    assert result["coverage"] == {  # type: ignore[comparison-overlap]
        "expected_calendar_days": 30,
        "point_count": 2,
        "missing_calendar_days": 28,
        "first_date": "2026-08-06",
        "last_date": "2026-08-08",
        "gap_policy": "missing_dates_are_omitted_not_zero_filled",
    }


def test_daily_snapshot_persists_only_bounded_broker_evidence(session: Session) -> None:
    view = reporting.dashboard(session, as_of=NOW, broker_read=broker_result(as_of=NOW))
    snapshot, created = valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=view,
        reporting_timezone="Asia/Taipei",
        captured_at=NOW,
    )

    assert created is True
    assert snapshot.broker_market_value == Decimal("12000.000000")
    assert snapshot.broker_position_count == 1
    assert '"status": "complete"' in snapshot.evidence_json
    assert "opaque_id" not in snapshot.evidence_json
    assert "masked_label" not in snapshot.evidence_json
    assert "2330" not in snapshot.evidence_json
    assert "positions" not in snapshot.evidence_json
    assert '"source_as_of": "2026-08-06T04:00:00+00:00"' in snapshot.evidence_json


def test_string_provider_timestamp_is_normalized_to_utc(session: Session) -> None:
    view = reporting.dashboard(session, as_of=NOW, broker_read=broker_result(as_of=NOW))
    broker = view["broker"]  # type: ignore[assignment]
    broker["source_as_of"] = "2026-08-06T12:00:00+08:00"
    snapshot, _ = valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=view,
        reporting_timezone="Asia/Taipei",
        captured_at=NOW,
    )

    assert '"source_as_of": "2026-08-06T04:00:00+00:00"' in snapshot.evidence_json


def test_unavailable_broker_value_remains_missing_instead_of_zero(session: Session) -> None:
    view = reporting.dashboard(session, as_of=NOW)
    snapshot, _ = valuation_history.capture_daily_snapshot(
        session,
        dashboard_view=view,
        reporting_timezone="Asia/Taipei",
        captured_at=NOW,
    )

    payload = valuation_history.snapshot_payload(snapshot)
    assert snapshot.broker_status == "disabled"
    assert snapshot.broker_market_value is None
    assert payload["metrics"]["broker_market_value"] is None  # type: ignore[index]


def test_upgrade_from_0003_creates_daily_snapshot_table(
    settings: Settings, tmp_path: Path
) -> None:
    database_path = tmp_path / "legacy-0003.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.execute(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            ("0003_mobile_connection",),
        )

    run_migrations(database_path, settings.project_root)
    database = Database(database_path)
    try:
        assert inspect(database.engine).has_table("daily_valuation_snapshots")
        with database.session() as session:
            assert (
                session.scalar(
                    select(func.count()).select_from(DailyValuationSnapshot)
                )
                == 0
            )
            assert (
                session.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
                == "0005_reporting_annotations"
            )
    finally:
        database.engine.dispose()
