from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path

from sqlalchemy import select

from personal_asset_os.database import Database
from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.models import Account
from personal_asset_os.settings import Settings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Configure PAOS and KGI Bridge for loopback-only read-time valuation."
    )
    parser.add_argument("--sdk-python", type=Path)
    parser.add_argument("--investment-account-id")
    parser.add_argument("--auto-map-kgi-account", action="store_true")
    return parser.parse_args()


def read_env(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8-sig").splitlines() if path.is_file() else []
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return lines, values


def configured_secret(value: str | None, *, minimum: int = 1) -> bool:
    normalized = (value or "").strip()
    return bool(
        len(normalized) >= minimum
        and "replace-with" not in normalized.casefold()
        and "replace_me" not in normalized.casefold()
    )


def set_values(path: Path, lines: list[str], updates: dict[str, str]) -> None:
    remaining = dict(updates)
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                output.append(f"{key}={remaining.pop(key)}")
                continue
        output.append(line)
    if output and output[-1] != "":
        output.append("")
    output.extend(f"{key}={value}" for key, value in remaining.items())
    path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")


def find_kgi_account_id(settings: Settings) -> str | None:
    if not settings.database_path.is_file():
        return None
    database = Database(settings.database_path)
    try:
        with database.session() as session:
            candidates = []
            for account in session.scalars(
                select(Account).where(
                    Account.kind == AccountKind.ASSET,
                    Account.subtype == AccountSubtype.INVESTMENT,
                    Account.is_active.is_(True),
                )
            ):
                label = f"{account.name} {account.institution or ''}".casefold()
                if "kgi" in label or "凱基" in label:
                    candidates.append(account.id)
    finally:
        database.engine.dispose()
    if len(candidates) > 1:
        raise SystemExit("Multiple KGI-like PAOS investment accounts found; pass one explicit id.")
    return candidates[0] if candidates else None


def main() -> int:
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    bridge_root = project_root / "kgi_broker_bridge"
    paos_env = project_root / ".env"
    bridge_env = bridge_root / ".env"
    if not bridge_env.is_file():
        raise SystemExit("kgi_broker_bridge/.env is missing")

    paos_settings = Settings(_env_file=paos_env if paos_env.is_file() else None)
    paos_lines, paos_values = read_env(paos_env)
    bridge_lines, bridge_values = read_env(bridge_env)
    if not configured_secret(bridge_values.get("KGI_BRIDGE_PERSON_ID")):
        raise SystemExit("KGI_BRIDGE_PERSON_ID is missing or still a placeholder")
    if not configured_secret(bridge_values.get("KGI_BRIDGE_PERSON_PASSWORD")):
        raise SystemExit("KGI_BRIDGE_PERSON_PASSWORD is missing or still a placeholder")

    token = bridge_values.get("KGI_BRIDGE_API_TOKEN")
    if not configured_secret(token, minimum=32):
        paos_token = paos_values.get("PAOS_BROKER_BRIDGE_API_TOKEN")
        token = (
            paos_token
            if configured_secret(paos_token, minimum=32)
            else secrets.token_urlsafe(48)
        )
    assert token is not None
    hash_key = bridge_values.get("KGI_BRIDGE_ACCOUNT_HASH_KEY")
    if not configured_secret(hash_key, minimum=32) or hash_key == token:
        hash_key = secrets.token_urlsafe(48)

    sdk_python = args.sdk_python or Path(bridge_values.get("KGI_BRIDGE_SDK_PYTHON", ""))
    if not sdk_python.is_absolute() or not sdk_python.is_file():
        raise SystemExit("Pass --sdk-python with the existing kgisuperpy Python executable")

    account_id = args.investment_account_id
    if args.auto_map_kgi_account and not account_id:
        account_id = find_kgi_account_id(paos_settings)

    bridge_updates = {
        "KGI_BRIDGE_API_TOKEN": token,
        "KGI_BRIDGE_ACCOUNT_HASH_KEY": hash_key,
        "KGI_BRIDGE_ADAPTER_MODE": "kgisuperpy",
        "KGI_BRIDGE_SIMULATION": "false",
        "KGI_BRIDGE_SDK_PYTHON": str(sdk_python.resolve()),
    }
    paos_updates = {
        "PAOS_BROKER_BRIDGE_ENABLED": "true",
        "PAOS_BROKER_BRIDGE_URL": "http://127.0.0.1:18878",
        "PAOS_BROKER_BRIDGE_API_TOKEN": token,
    }
    if account_id:
        paos_updates["PAOS_BROKER_INVESTMENT_ACCOUNT_ID"] = account_id.strip()

    set_values(bridge_env, bridge_lines, bridge_updates)
    set_values(paos_env, paos_lines, paos_updates)
    os.chmod(bridge_env, 0o600)
    os.chmod(paos_env, 0o600)
    print("KGI read-only configuration updated; secret values were not printed.")
    print(f"PAOS account mapping: {'configured' if account_id else 'unmapped'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
