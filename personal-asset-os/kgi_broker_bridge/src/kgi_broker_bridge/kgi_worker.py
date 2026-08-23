from __future__ import annotations

import contextlib
import importlib
import importlib.metadata
import io
import json
import math
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

RESULT_PREFIX = "KGI_BRIDGE_RESULT_V1="


class WorkerFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _classify_exception(exc: BaseException) -> str:
    detail = f"{type(exc).__name__} {exc}".casefold()
    if any(token in detail for token in ("憑證", "certificate", "cert", "ca ")):
        return "ca_failed"
    if any(token in detail for token in ("密碼", "password", "登入", "login", "auth")):
        return "auth_failed"
    if any(token in detail for token in ("timeout", "timed out", "逾時", "超時")):
        return "timeout"
    if any(token in detail for token in ("account", "帳號", "賬號")):
        return "account_unavailable"
    return "inventory_fetch_failed"


def _stock_account(api: object, configured: str | None) -> str:
    if configured:
        return configured

    show_account = getattr(api, "show_account", None)
    if not callable(show_account):
        raise WorkerFailure("auth_failed")
    accounts = show_account()
    if isinstance(accounts, list):
        for item in accounts:
            if not isinstance(item, Mapping):
                continue
            account_flag = str(item.get("account_flag", "")).strip().casefold()
            account = str(item.get("account", "")).strip()
            if account and account_flag in {"證券", "s", "stock", "securities"}:
                return account

    login_info = getattr(api, "login_info", None)
    if callable(login_info):
        info = login_info()
        if isinstance(info, Mapping):
            securities = info.get("證券")
            if isinstance(securities, Mapping):
                account = str(securities.get("account", "")).strip()
                if account:
                    return account
    raise WorkerFailure("account_unavailable")


def _sub_account(api: object, configured: str | None) -> str:
    if configured:
        return configured

    show_account = getattr(api, "show_account", None)
    if not callable(show_account):
        raise WorkerFailure("auth_failed")
    accounts = show_account()
    if isinstance(accounts, list):
        for item in accounts:
            if not isinstance(item, Mapping):
                continue
            account_flag = str(item.get("account_flag", "")).strip().casefold()
            account = str(item.get("account", "")).strip()
            if account and account_flag in {
                "複委託",
                "复委托",
                "o",
                "subaccount",
                "overseas",
                "foreign",
            }:
                return account

    login_info = getattr(api, "login_info", None)
    if callable(login_info):
        info = login_info()
        if isinstance(info, Mapping):
            for key in ("複委託", "复委托", "海外證券", "海外证券"):
                overseas = info.get(key)
                if isinstance(overseas, Mapping):
                    account = str(overseas.get("account", "")).strip()
                    if account:
                        return account
    raise WorkerFailure("account_unavailable")


def _json_scalar(value: object) -> object:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    item = getattr(value, "item", None)
    if callable(item):
        normalized = item()
        if normalized is not value:
            return _json_scalar(normalized)
    try:
        missing = bool(value != value)
    except (TypeError, ValueError):
        missing = False
    if missing:
        return None
    return str(value)


def _json_rows(raw_rows: object) -> list[dict[str, object]]:
    if not isinstance(raw_rows, list):
        raise WorkerFailure("inventory_fetch_failed")
    result: list[dict[str, object]] = []
    for row in raw_rows:
        if not isinstance(row, Mapping):
            raise WorkerFailure("inventory_fetch_failed")
        result.append({str(key): _json_scalar(value) for key, value in row.items()})
    return result


def _dataframe_rows(value: object) -> list[dict[str, object]]:
    if value is None:
        raise WorkerFailure("inventory_fetch_failed")
    to_dict = getattr(value, "to_dict", None)
    if not callable(to_dict):
        raise WorkerFailure("inventory_fetch_failed")
    return _json_rows(to_dict(orient="records"))


def _tw_scope(api: object, configured: str | None) -> dict[str, object]:
    account = _stock_account(api, configured)
    set_account = getattr(api, "set_Account", None)
    if not callable(set_account):
        raise WorkerFailure("auth_failed")
    set_account(account)
    account_api = getattr(api, "Account", None)
    inventory_sum = getattr(account_api, "InventorySum", None)
    if not callable(inventory_sum):
        raise WorkerFailure("account_unavailable")
    rows = _dataframe_rows(inventory_sum("B"))
    captured_at = datetime.now(UTC)
    return {
        "market": "TW",
        "account_ref": account,
        "source_as_of": captured_at.isoformat(),
        "explicit_empty": not rows,
        "rows": rows,
        "warnings": ["source_as_of_inferred_from_capture_time"],
        "error_code": None,
    }


def _us_scope(api: object, configured: str | None) -> dict[str, object]:
    account = _sub_account(api, configured)
    set_account = getattr(api, "set_SubAccount", None)
    if not callable(set_account):
        raise WorkerFailure("account_unavailable")
    set_account(account)
    sub_api = getattr(api, "SubAccount", None)
    stock_position_report = getattr(sub_api, "StockPositionReport", None)
    if not callable(stock_position_report):
        raise WorkerFailure("account_unavailable")
    rows = _dataframe_rows(stock_position_report())
    warnings: list[str] = []
    symbols = list(
        dict.fromkeys(
            str(row.get("symbol", "")).strip().upper()
            for row in rows
            if str(row.get("symbol", "")).strip()
        )
    )
    if symbols:
        try:
            us_data = getattr(api, "USData", None)
            get_snapshots = getattr(us_data, "get_snapshots", None)
            if not callable(get_snapshots):
                raise RuntimeError("US snapshot API unavailable")
            snapshots = get_snapshots(*symbols)
            if not isinstance(snapshots, Mapping):
                raise RuntimeError("US snapshot response invalid")
            for row in rows:
                symbol = str(row.get("symbol", "")).strip().upper()
                quote = snapshots.get(symbol)
                if quote is None:
                    warnings.append(f"us_snapshot_missing:{symbol}")
                    continue
                row["_snapshot_close"] = _json_scalar(getattr(quote, "close", None))
                row["_snapshot_timestamp"] = _json_scalar(
                    getattr(quote, "timestamp", None)
                )
        except BaseException:
            warnings.append("us_snapshot_fetch_failed_using_report_close")
    captured_at = datetime.now(UTC)
    warnings.append("provider_timestamp_timezone_assumed_america_new_york")
    return {
        "market": "US",
        "account_ref": account,
        "source_as_of": captured_at.isoformat(),
        "explicit_empty": not rows,
        "rows": rows,
        "warnings": list(dict.fromkeys(warnings)),
        "error_code": None,
    }


def _unavailable_scope(market: str, exc: BaseException) -> dict[str, object]:
    code = exc.code if isinstance(exc, WorkerFailure) else _classify_exception(exc)
    return {
        "market": market,
        "account_ref": None,
        "source_as_of": None,
        "explicit_empty": False,
        "rows": [],
        "warnings": (),
        "error_code": code,
    }


def run_positions(kgi_module: Any) -> dict[str, object]:
    person_id = os.environ.pop("KGI_BRIDGE_PERSON_ID", "").strip()
    password = os.environ.pop("KGI_BRIDGE_PERSON_PASSWORD", "").strip()
    stock_account = os.environ.pop("KGI_BRIDGE_STOCK_ACCOUNT", "").strip() or None
    simulation = os.environ.pop("KGI_BRIDGE_SIMULATION", "false").casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not person_id or not password:
        raise WorkerFailure("auth_failed")

    captured_output = io.StringIO()
    api: object | None = None
    try:
        with contextlib.redirect_stdout(captured_output), contextlib.redirect_stderr(
            captured_output
        ):
            api = kgi_module.login(person_id, password, simulation)
            account = _stock_account(api, stock_account)
            set_account = getattr(api, "set_Account", None)
            if not callable(set_account):
                raise WorkerFailure("auth_failed")
            set_account(account)
            account_api = getattr(api, "Account", None)
            inventory_sum = getattr(account_api, "InventorySum", None)
            if not callable(inventory_sum):
                raise WorkerFailure("account_unavailable")
            holdings = inventory_sum("B")
    except WorkerFailure:
        raise
    except BaseException as exc:
        raise WorkerFailure(_classify_exception(exc)) from exc
    finally:
        if api is not None:
            with contextlib.redirect_stdout(captured_output), contextlib.redirect_stderr(
                captured_output
            ):
                logout = getattr(api, "logout", None)
                if callable(logout):
                    try:
                        logout()
                    except BaseException:
                        pass
        captured_output.close()

    rows = _dataframe_rows(holdings)
    captured_at = datetime.now(UTC)
    try:
        package_version = importlib.metadata.version("kgisuperpy")
    except importlib.metadata.PackageNotFoundError:
        package_version = None
    return {
        "ok": True,
        "account_ref": account,
        "captured_at": captured_at.isoformat(),
        "source_as_of": captured_at.isoformat(),
        "explicit_empty": not rows,
        "rows": rows,
        "warnings": [
            "source_as_of_inferred_from_capture_time",
            "one_shot_worker_session",
        ],
        "package_version": package_version,
    }


def run_positions_v2(kgi_module: Any) -> dict[str, object]:
    person_id = os.environ.pop("KGI_BRIDGE_PERSON_ID", "").strip()
    password = os.environ.pop("KGI_BRIDGE_PERSON_PASSWORD", "").strip()
    stock_account = os.environ.pop("KGI_BRIDGE_STOCK_ACCOUNT", "").strip() or None
    sub_account = os.environ.pop("KGI_BRIDGE_SUB_ACCOUNT", "").strip() or None
    simulation = os.environ.pop("KGI_BRIDGE_SIMULATION", "false").casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not person_id or not password:
        raise WorkerFailure("auth_failed")

    captured_output = io.StringIO()
    api: object | None = None
    try:
        with contextlib.redirect_stdout(captured_output), contextlib.redirect_stderr(
            captured_output
        ):
            api = kgi_module.login(person_id, password, simulation)
            account_selections: dict[str, str | BaseException] = {}
            try:
                account_selections["TW"] = _stock_account(api, stock_account)
            except BaseException as exc:
                account_selections["TW"] = exc
            try:
                account_selections["US"] = _sub_account(api, sub_account)
            except BaseException as exc:
                account_selections["US"] = exc

            scopes: list[dict[str, object]] = []
            tw_selection = account_selections["TW"]
            if isinstance(tw_selection, BaseException):
                scopes.append(_unavailable_scope("TW", tw_selection))
            else:
                try:
                    scopes.append(_tw_scope(api, tw_selection))
                except BaseException as exc:
                    scopes.append(_unavailable_scope("TW", exc))
            us_selection = account_selections["US"]
            if isinstance(us_selection, BaseException):
                scopes.append(_unavailable_scope("US", us_selection))
            else:
                try:
                    scopes.append(_us_scope(api, us_selection))
                except BaseException as exc:
                    scopes.append(_unavailable_scope("US", exc))
    except WorkerFailure:
        raise
    except BaseException as exc:
        raise WorkerFailure(_classify_exception(exc)) from exc
    finally:
        if api is not None:
            with contextlib.redirect_stdout(captured_output), contextlib.redirect_stderr(
                captured_output
            ):
                logout = getattr(api, "logout", None)
                if callable(logout):
                    try:
                        logout()
                    except BaseException:
                        pass
        captured_output.close()

    captured_at = datetime.now(UTC)
    try:
        package_version = importlib.metadata.version("kgisuperpy")
    except importlib.metadata.PackageNotFoundError:
        package_version = None
    return {
        "ok": True,
        "captured_at": captured_at.isoformat(),
        "scopes": scopes,
        "warnings": ["one_shot_worker_session"],
        "package_version": package_version,
    }


def _emit(payload: dict[str, object]) -> None:
    serialized = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    output = sys.__stdout__
    if output is None:
        raise RuntimeError("worker stdout is unavailable")
    output.write(f"{RESULT_PREFIX}{serialized}\n")
    output.flush()


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"positions", "positions-v2"}:
        _emit({"ok": False, "error_code": "internal_error"})
        return 2
    try:
        kgi = importlib.import_module("kgisuperpy")
    except BaseException:
        _emit({"ok": False, "error_code": "sdk_unavailable"})
        return 3
    try:
        payload = run_positions(kgi) if sys.argv[1] == "positions" else run_positions_v2(kgi)
        _emit(payload)
    except WorkerFailure as exc:
        _emit({"ok": False, "error_code": exc.code})
        return 1
    except BaseException:
        _emit({"ok": False, "error_code": "internal_error"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
