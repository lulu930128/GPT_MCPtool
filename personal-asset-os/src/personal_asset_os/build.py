from __future__ import annotations

import hashlib
from pathlib import Path

BUILD_PATTERNS = ("*.py", "*.ts", "*.tsx", "*.css", "*.html", "*.toml")
IGNORED_PARTS = {".venv", "node_modules", "dist", ".git", "__pycache__"}


def source_build_id(
    project_root: Path | None = None, *, frontend_dist: Path | None = None
) -> str:
    root = project_root or Path(__file__).resolve().parents[2]
    candidates: set[Path] = set()
    for base in (root / "src", root / "frontend" / "src", root / "migrations"):
        if not base.exists():
            continue
        for pattern in BUILD_PATTERNS:
            candidates.update(base.rglob(pattern))
    for direct in (
        root / "pyproject.toml", root / "uv.lock", root / "alembic.ini",
        root / "frontend" / "package.json", root / "frontend" / "package-lock.json",
        root / "frontend" / "index.html", root / "frontend" / "vite.config.ts",
        root / "frontend" / "tsconfig.json", root / "frontend" / "tsconfig.app.json",
        root / "frontend" / "tsconfig.node.json",
    ):
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
    # Staging and startup use the same logical paths, independent of the
    # operation directory. This binds the delivered UI to the loaded build.
    dist = frontend_dist if frontend_dist is not None else root / "frontend" / "dist"
    if dist.exists():
        for path in sorted(item for item in dist.rglob("*") if item.is_file()):
            digest.update(("frontend/dist/" + path.relative_to(dist).as_posix()).encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()[:16]
