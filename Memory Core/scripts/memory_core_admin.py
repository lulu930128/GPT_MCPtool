from __future__ import annotations

import argparse
from pathlib import Path

from sqlalchemy import select

from memory_core.config import Settings
from memory_core.db import Database
from memory_core.models import ClientCredential
from memory_core.operations import verify_sqlite_backup
from memory_core.security import generate_token, hash_token

KNOWN_SCOPES = {
    "records:read",
    "records:write",
    "entities:read",
    "entities:write",
    "restricted:read",
    "restricted:write",
    "candidates:create",
    "candidates:review",
    "admin:export",
    "admin:backup",
}


def create_client(name: str, scopes: list[str]) -> int:
    invalid = set(scopes) - KNOWN_SCOPES - {"*"}
    if invalid:
        raise SystemExit(f"Unknown scopes: {', '.join(sorted(invalid))}")
    settings = Settings()
    database = Database(settings)
    token = generate_token()
    with database.session_factory() as session:
        existing = session.scalar(select(ClientCredential).where(ClientCredential.name == name))
        if existing:
            raise SystemExit(f"Client name already exists: {name}")
        credential = ClientCredential(
            name=name,
            token_hash=hash_token(token),
            scopes=sorted(set(scopes)),
        )
        session.add(credential)
        session.commit()
    print(f"Client: {name}")
    print(f"Token: {token}")
    print("Store this token securely. Memory Core cannot recover it later.")
    return 0


def verify_backup(path: Path) -> int:
    result = verify_sqlite_backup(path)
    print(f"Integrity: {result['integrity']}")
    print(f"Records: {result['records']}")
    print(f"Entities: {result['entities']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Memory Core local administration")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create-client", help="Create a scoped client token")
    create.add_argument("--name", required=True)
    create.add_argument("--scope", action="append", dest="scopes", required=True)

    verify = subparsers.add_parser("verify-backup", help="Verify a SQLite backup")
    verify.add_argument("path", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "create-client":
        return create_client(args.name, args.scopes)
    if args.command == "verify-backup":
        return verify_backup(args.path)
    raise SystemExit("Unknown command")


if __name__ == "__main__":
    raise SystemExit(main())
