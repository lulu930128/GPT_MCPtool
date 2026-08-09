from __future__ import annotations

import hashlib
from pathlib import Path

BUILD_PATTERNS = ("*.py", "*.ts", "*.tsx", "*.css", "*.html", "*.toml")
IGNORED_PARTS = {".venv", "node_modules", "dist", ".git", "__pycache__"}


def source_build_id(project_root: Path | None = None) -> str:
    root = project_root or Path(__file__).resolve().parents[2]
    candidates: set[Path] = set()
    for base in (root / "src", root / "frontend" / "src", root / "migrations"):
        if not base.exists():
            continue
        for pattern in BUILD_PATTERNS:
            candidates.update(base.rglob(pattern))
    for direct in (root / "pyproject.toml", root / "frontend" / "package.json"):
        if direct.exists():
            candidates.add(direct)

    digest = hashlib.sha256()
    for path in sorted(candidates, key=lambda item: item.as_posix().lower()):
        if any(part in IGNORED_PARTS for part in path.parts):
            continue
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]
