from __future__ import annotations

import os
from dataclasses import dataclass

import pytest

from kgi_broker_bridge.kgi_worker import WorkerFailure, run_positions, run_positions_v2


@dataclass
class FakeHoldings:
    rows: list[dict[str, object]]

    def to_dict(self, *, orient: str) -> list[dict[str, object]]:
        assert orient == "records"
        return self.rows


class FakeAccountApi:
    def __init__(self, holdings: FakeHoldings | None) -> None:
        self.holdings = holdings
        self.book_codes: list[str] = []

    def InventorySum(self, book_code: str) -> FakeHoldings | None:  # noqa: N802
        self.book_codes.append(book_code)
        return self.holdings


class FakeApi:
    def __init__(self, holdings: FakeHoldings | None) -> None:
        self.Account = FakeAccountApi(holdings)
        self.selected: str | None = None
        self.logged_out = False

    def show_account(self) -> list[dict[str, str]]:
        print("SYNTHETIC-ACCOUNT-SHOULD-BE-CAPTURED")
        return [
            {"account_flag": "期貨", "account": "FUTURE-0001"},
            {"account_flag": "證券", "account": "STOCK-0001"},
        ]

    def set_Account(self, account: str) -> None:  # noqa: N802
        self.selected = account

    def logout(self) -> None:
        self.logged_out = True


class FakeKGI:
    def __init__(self, api: object) -> None:
        self.api = api
        self.login_args: tuple[str, str, bool] | None = None

    def login(self, person_id: str, password: str, simulation: bool) -> object:
        print("SYNTHETIC-LOGIN-OUTPUT-SHOULD-BE-CAPTURED")
        self.login_args = (person_id, password, simulation)
        return self.api


def _set_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KGI_BRIDGE_PERSON_ID", "SYNTHETIC-PERSON-ID")
    monkeypatch.setenv("KGI_BRIDGE_PERSON_PASSWORD", "SYNTHETIC-PASSWORD")
    monkeypatch.setenv("KGI_BRIDGE_SIMULATION", "false")
    monkeypatch.delenv("KGI_BRIDGE_STOCK_ACCOUNT", raising=False)
    monkeypatch.delenv("KGI_BRIDGE_SUB_ACCOUNT", raising=False)


def test_worker_selects_securities_account_and_suppresses_vendor_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _set_credentials(monkeypatch)
    api = FakeApi(FakeHoldings([{"Symbol": "0050", "NETQTY0": 1000}]))
    kgi = FakeKGI(api)

    payload = run_positions(kgi)

    assert payload["ok"] is True
    assert payload["account_ref"] == "STOCK-0001"
    assert payload["explicit_empty"] is False
    assert api.selected == "STOCK-0001"
    assert api.Account.book_codes == ["B"]
    assert api.logged_out is True
    assert "KGI_BRIDGE_PERSON_PASSWORD" not in os.environ
    assert capsys.readouterr().out == ""


def test_worker_treats_successful_empty_dataframe_as_explicit_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)
    payload = run_positions(FakeKGI(FakeApi(FakeHoldings([]))))

    assert payload["explicit_empty"] is True
    assert payload["rows"] == []


def test_worker_rejects_none_inventory_and_failed_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)
    with pytest.raises(WorkerFailure) as missing_inventory:
        run_positions(FakeKGI(FakeApi(None)))
    assert missing_inventory.value.code == "inventory_fetch_failed"

    with pytest.raises(WorkerFailure) as failed_login:
        run_positions(FakeKGI(object()))
    assert failed_login.value.code == "auth_failed"


def test_worker_uses_configured_account_without_discovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)
    monkeypatch.setenv("KGI_BRIDGE_STOCK_ACCOUNT", "MANUAL-0001")

    class ManualApi:
        def __init__(self) -> None:
            self.Account = FakeAccountApi(FakeHoldings([]))
            self.selected: str | None = None

        def set_Account(self, account: str) -> None:  # noqa: N802
            self.selected = account

    api = ManualApi()
    payload = run_positions(FakeKGI(api))
    assert api.selected == "MANUAL-0001"
    assert payload["account_ref"] == "MANUAL-0001"


def test_v2_worker_reads_us_positions_and_held_symbol_snapshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)

    @dataclass
    class Quote:
        close: float
        timestamp: str

    class USData:
        requested: tuple[str, ...] = ()

        def get_snapshots(self, *symbols: str) -> dict[str, Quote]:
            self.requested = symbols
            return {"AAPL": Quote(close=200.5, timestamp="20260819160000000")}

    class SubAccountApi:
        def StockPositionReport(self) -> FakeHoldings:  # noqa: N802
            return FakeHoldings(
                [
                    {
                        "symbol": "AAPL",
                        "symbol_name": "Apple Inc.",
                        "market": "US",
                        "currency": "USD",
                        "Qty": "2",
                        "market_price": "199",
                        "close_date": "20260818",
                    }
                ]
            )

    class V2Api(FakeApi):
        def __init__(self) -> None:
            super().__init__(FakeHoldings([{"Symbol": "0050", "NETQTY0": 1000}]))
            self.SubAccount = SubAccountApi()
            self.USData = USData()
            self.selected_sub: str | None = None

        def show_account(self) -> list[dict[str, str]]:
            return [
                {"account_flag": "證券", "account": "STOCK-0001"},
                {"account_flag": "複委託", "account": "SUB-0001"},
            ]

        def set_SubAccount(self, account: str) -> None:  # noqa: N802
            self.selected_sub = account

    api = V2Api()
    payload = run_positions_v2(FakeKGI(api))
    us_scope = next(scope for scope in payload["scopes"] if scope["market"] == "US")  # type: ignore[index]

    assert us_scope["account_ref"] == "SUB-0001"
    assert us_scope["rows"][0]["_snapshot_close"] == 200.5
    assert api.USData.requested == ("AAPL",)
    assert api.selected_sub == "SUB-0001"


def test_v2_worker_resolves_both_accounts_before_selecting_either(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)

    class SelectionSensitiveApi(FakeApi):
        def __init__(self) -> None:
            super().__init__(FakeHoldings([{"Symbol": "0050", "NETQTY0": 1000}]))
            self.SubAccount = type(
                "SubAccountApi",
                (),
                {"StockPositionReport": lambda self: FakeHoldings([])},
            )()
            self.selected_sub: str | None = None

        def show_account(self) -> list[dict[str, str]]:
            accounts = [{"account_flag": "證券", "account": "STOCK-0001"}]
            if self.selected is None:
                accounts.append({"account_flag": "複委託", "account": "SUB-0001"})
            return accounts

        def set_SubAccount(self, account: str) -> None:  # noqa: N802
            self.selected_sub = account

    api = SelectionSensitiveApi()
    payload = run_positions_v2(FakeKGI(api))
    scopes = {scope["market"]: scope for scope in payload["scopes"]}  # type: ignore[index]

    assert scopes["TW"]["error_code"] is None
    assert scopes["US"]["error_code"] is None
    assert scopes["US"]["explicit_empty"] is True
    assert api.selected == "STOCK-0001"
    assert api.selected_sub == "SUB-0001"


def test_v2_worker_returns_partial_scope_without_erasing_tw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_credentials(monkeypatch)
    api = FakeApi(FakeHoldings([{"Symbol": "0050", "NETQTY0": 1000}]))

    payload = run_positions_v2(FakeKGI(api))
    scopes = {scope["market"]: scope for scope in payload["scopes"]}  # type: ignore[index]

    assert scopes["TW"]["error_code"] is None
    assert scopes["TW"]["rows"]
    assert scopes["US"]["error_code"] == "account_unavailable"
