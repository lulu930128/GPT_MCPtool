from __future__ import annotations

import hashlib
from pathlib import Path


def source_build_id(project_root: Path | None = None) -> str:
    """Hash public executable inputs only; never inspect config or formal data."""
    root = project_root or Path(__file__).resolve().parents[2]
    candidates: set[Path] = set()
    for base in (root / "src" / "memory_core", root / "migrations"):
        candidates.update(base.rglob("*.py"))
    candidates.update((root / "src" / "memory_core" / "normalization" / "profiles").glob("*.json"))
    for name in ("pyproject.toml", "uv.lock"):
        path = root / name
        if path.is_file():
            candidates.add(path)
    digest = hashlib.sha256()
    for path in sorted(candidates, key=lambda item: item.relative_to(root).as_posix()):
        if "__pycache__" in path.parts:
            continue
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            raise RuntimeError("BUILD_SOURCE_REPARSE_REJECTED")
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]


# Captured once per process. Health must never hash today's edited source and
# mislabel a still-running old process as the new build.
STARTUP_BUILD_ID = source_build_id()


if __name__ == "__main__":
    print(STARTUP_BUILD_ID)
