from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.database import Database
from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.models import (
    Account,
    DailyValuationSnapshot,
    LedgerTransaction,
    Snapshot,
)
from personal_asset_os.services import backup, ledger, reporting, valuation_history
from personal_asset_os.settings import Settings
from tests.helpers import NOW, add_account


def test_reconciliation_difference_is_visible(session: Session) -> None:
    bank = add_account(
        session,
        "對帳銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    reporting.record_balance_observation(
        session,
        account_id=bank.id,
        reported_balance=Decimal("980"),
        observed_at=NOW,
        source="bank app",
    )
    data = reporting.dashboard(session, as_of=NOW + timedelta(minutes=1))
    assert data["metrics"]["unresolved_count"] == 1  # type: ignore[index]
    assert data["metrics"]["unresolved_total"] == Decimal("20.000000")  # type: ignore[index]
    assert data["reconciliations"][0]["difference"] == Decimal("-20.000000")  # type: ignore[index]


def test_month_close_is_idempotent_and_preserves_original_snapshot(session: Session) -> None:
    add_account(
        session,
        "月結銀行",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    first, created_first = reporting.close_month(session, period_key="2026-08", as_of=NOW)
    second, created_second = reporting.close_month(
        session, period_key="2026-08", as_of=NOW + timedelta(days=1)
    )
    assert created_first is True
    assert created_second is False
    assert first.id == second.id
    assert first.metrics_json == second.metrics_json


def test_backup_restore_recovers_core_rows(
    settings: Settings, database: Database, tmp_path: Path
) -> None:
    with database.session() as session:
        bank = add_account(
            session,
            "備份銀行",
            AccountKind.ASSET,
            AccountSubtype.BANK,
            liquid=True,
            opening=Decimal("3210"),
        )
        ledger.record_expense(
            session,
            payment_account_id=bank.id,
            amount=Decimal("210"),
            occurred_at=NOW,
            description="備份測試",
        )
        reporting.close_month(session, period_key="2026-08", as_of=NOW)
        valuation_history.capture_daily_snapshot(
            session,
            dashboard_view=reporting.dashboard(session, as_of=NOW),
            reporting_timezone="Asia/Taipei",
            captured_at=NOW,
        )

    result = backup.create_backup(settings.database_path, settings.backup_dir, now=NOW)
    backup_path = Path(str(result["backup_path"]))
    assert result["integrity_check"] == "ok"
    assert backup.verify_backup(backup_path)["verified"] is True

    restored_path = tmp_path / "restored" / "personal_asset_os.db"
    backup.restore_backup(backup_path, restored_path)
    restored = Database(restored_path)
    try:
        with restored.session() as session:
            assert session.scalar(select(func.count()).select_from(Account)) >= 7
            assert session.scalar(select(func.count()).select_from(LedgerTransaction)) == 2
            assert session.scalar(select(func.count()).select_from(Snapshot)) == 1
            assert (
                session.scalar(select(func.count()).select_from(DailyValuationSnapshot)) == 1
            )
    finally:
        restored.engine.dispose()


def test_confirm_observation_is_balanced_idempotent_and_preserves_later_spending(
    session: Session,
) -> None:
    bank = add_account(session, "盤點", AccountKind.ASSET, AccountSubtype.BANK,
                       liquid=True, opening=Decimal("1000"))
    observation = reporting.record_balance_observation(
        session, account_id=bank.id, reported_balance=Decimal("800"),
        observed_at=NOW, source="盤點",
    )
    ledger.record_expense(session, payment_account_id=bank.id, amount=Decimal("50"),
                          occurred_at=NOW + timedelta(minutes=1), description="後續消費")
    result = reporting.confirm_balance_observation(session, observation.id,
                                                   expected_difference=Decimal("-200"))
    assert result["created"] is True
    assert ledger.account_balance(session, bank.id) == Decimal("750")
    again = reporting.confirm_balance_observation(session, observation.id,
                                                  expected_difference=Decimal("-200"))
    assert again["created"] is False
    assert again["transaction_id"] == result["transaction_id"]
    data = reporting.dashboard(session, as_of=NOW + timedelta(minutes=2))
    assert data["reconciliations"][0]["difference"] == Decimal("0")
    assert data["metrics"]["monthly_expense"] == Decimal("50")


def test_confirm_observation_rejects_changed_difference(session: Session) -> None:
    import pytest

    from personal_asset_os.errors import ConflictError
    bank = add_account(session, "盤點", AccountKind.ASSET, AccountSubtype.BANK,
                       liquid=True, opening=Decimal("1000"))
    observation = reporting.record_balance_observation(
        session, account_id=bank.id, reported_balance=Decimal("800"),
        observed_at=NOW, source="盤點",
    )
    with pytest.raises(ConflictError):
        reporting.confirm_balance_observation(session, observation.id,
                                               expected_difference=Decimal("-100"))
    assert ledger.account_balance(session, bank.id) == Decimal("1000")
    assert observation.reconciled is False
