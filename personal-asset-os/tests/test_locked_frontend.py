import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "check_locked_frontend",
    Path(__file__).resolve().parents[1] / "scripts/check-locked-frontend.py",
)
assert spec and spec.loader
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def fixture_tree(root: Path) -> None:
    (root / "package.json").write_text('{"dependencies":{"example":"1.0.0"}}')
    (root / "package-lock.json").write_text(json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"example": "1.0.0"}},
            "node_modules/example": {"version": "1.0.0"},
            "node_modules/other-platform": {"version": "2.0.0", "optional": True},
        },
    }))
    package = root / "node_modules/example"
    package.mkdir(parents=True)
    (package / "package.json").write_text('{"version":"1.0.0"}')


def test_locked_frontend_allows_absent_optional_platform_package(tmp_path: Path) -> None:
    fixture_tree(tmp_path)
    checker.check_locked_frontend(tmp_path)


@pytest.mark.parametrize("change", ["manifest", "version", "missing"])
def test_locked_frontend_rejects_dependency_drift(tmp_path: Path, change: str) -> None:
    fixture_tree(tmp_path)
    package = tmp_path / "node_modules/example/package.json"
    if change == "manifest":
        (tmp_path / "package.json").write_text('{"dependencies":{"example":"2.0.0"}}')
    elif change == "version":
        package.write_text('{"version":"2.0.0"}')
    else:
        package.unlink()
    with pytest.raises((ValueError, OSError)):
        checker.check_locked_frontend(tmp_path)
