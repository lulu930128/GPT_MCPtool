"""Read-only lock/environment check; never install or run package lifecycle hooks."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def check_locked_frontend(root: Path) -> None:
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    if lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
        raise ValueError("DEPENDENCY_PREPARATION_REQUIRED")
    packages = lock["packages"]
    for group in ("dependencies", "devDependencies", "optionalDependencies"):
        if manifest.get(group, {}) != packages.get("", {}).get(group, {}):
            raise ValueError("DEPENDENCY_PREPARATION_REQUIRED")
    for name, expected in packages.items():
        if not name:
            continue
        if not name.startswith("node_modules/") or ".." in Path(name).parts:
            raise ValueError("DEPENDENCY_PREPARATION_REQUIRED")
        package = root / name / "package.json"
        if not package.is_file() and expected.get("optional"):
            continue
        actual = json.loads(package.read_text(encoding="utf-8"))
        if expected.get("link") or actual.get("version") != expected.get("version"):
            raise ValueError("DEPENDENCY_PREPARATION_REQUIRED")


if __name__ == "__main__":
    try:
        check_locked_frontend(Path(__file__).resolve().parents[1] / "frontend")
    except (OSError, ValueError, TypeError, KeyError):
        print("DEPENDENCY_PREPARATION_REQUIRED", file=sys.stderr)
        raise SystemExit(1) from None
