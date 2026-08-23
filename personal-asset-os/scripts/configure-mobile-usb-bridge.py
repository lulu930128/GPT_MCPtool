from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Configure the ignored PAOS .env for one authorized Android device."
    )
    parser.add_argument("--adb-path", required=True, type=Path)
    parser.add_argument("--server-socket", default="tcp:localhost:5037")
    parser.add_argument("--serial")
    parser.add_argument("--env-file", type=Path)
    return parser.parse_args()


def parse_devices(value: str) -> list[tuple[str, str]]:
    devices: list[tuple[str, str]] = []
    for line in value.splitlines():
        normalized = line.strip()
        if not normalized or normalized.startswith("List of devices attached"):
            continue
        fields = normalized.split()
        if len(fields) >= 2:
            devices.append((fields[0], fields[1]))
    return devices


def choose_serial(devices: list[tuple[str, str]], configured: str | None) -> str:
    if configured:
        matched = [item for item in devices if item[0] == configured]
        if len(matched) != 1 or matched[0][1] != "device":
            raise SystemExit("Configured Android device is not authorized and online.")
        return configured
    authorized = [serial for serial, state in devices if state == "device"]
    if len(devices) != 1 or len(authorized) != 1:
        raise SystemExit("Exactly one authorized Android device is required.")
    return authorized[0]


def env_value(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:\\-]+", value):
        return value
    return json.dumps(value, ensure_ascii=False)


def upsert_env(path: Path, values: dict[str, str]) -> None:
    original = path.read_text(encoding="utf-8") if path.is_file() else ""
    lines = original.splitlines()
    remaining = dict(values)
    updated: list[str] = []
    for line in lines:
        match = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if match and match.group(1) in remaining:
            key = match.group(1)
            updated.append(f"{key}={env_value(remaining.pop(key))}")
        else:
            updated.append(line)
    if remaining:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append("# PAOS-owned Android USB sync bridge")
        updated.extend(f"{key}={env_value(value)}" for key, value in remaining.items())
    payload = "\n".join(updated).rstrip() + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    temporary.write_text(payload, encoding="utf-8", newline="\n")
    temporary.replace(path)


def main() -> int:
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    env_path = (args.env_file or project_root / ".env").resolve()
    adb_path = args.adb_path.expanduser().resolve()
    if not adb_path.is_file() or adb_path.suffix.lower() != ".exe":
        raise SystemExit("--adb-path must point to an existing adb.exe.")
    socket_match = re.fullmatch(
        r"tcp:(?:localhost|127\.0\.0\.1):(\d{1,5})", args.server_socket
    )
    if socket_match is None or not 1 <= int(socket_match.group(1)) <= 65535:
        raise SystemExit("--server-socket must use tcp:localhost:<port>.")
    environment = os.environ.copy()
    environment["ADB_SERVER_SOCKET"] = args.server_socket
    completed = subprocess.run(
        [str(adb_path), "devices"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
        timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise SystemExit("ADB device discovery failed.")
    serial = choose_serial(parse_devices(completed.stdout), args.serial)
    upsert_env(
        env_path,
        {
            "PAOS_MOBILE_USB_BRIDGE_ENABLED": "true",
            "PAOS_MOBILE_ADB_PATH": str(adb_path),
            "PAOS_MOBILE_ADB_SERVER_SOCKET": args.server_socket,
            "PAOS_MOBILE_ADB_SERIAL": serial,
            "PAOS_MOBILE_USB_BRIDGE_POLL_SECONDS": "5",
        },
    )
    print("Mobile USB bridge configured for one authorized device.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
