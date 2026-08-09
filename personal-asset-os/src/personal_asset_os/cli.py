from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import NoReturn

import uvicorn

from personal_asset_os.app import create_app
from personal_asset_os.build import source_build_id
from personal_asset_os.migrations import run_migrations
from personal_asset_os.services.ai import check_connection
from personal_asset_os.services.backup import create_backup, restore_backup, verify_backup
from personal_asset_os.settings import Settings


def _settings_from_args(args: argparse.Namespace) -> Settings:
    defaults = Settings()
    host = str(args.host) if getattr(args, "host", None) else defaults.host
    port = int(args.port) if getattr(args, "port", None) else defaults.port
    data_dir = Path(args.data_dir) if getattr(args, "data_dir", None) else defaults.data_dir
    return Settings(host=host, port=port, data_dir=data_dir)


def _json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str, sort_keys=True))


def _serve(args: argparse.Namespace) -> None:
    settings = _settings_from_args(args)
    settings.ensure_directories()
    pid_file = settings.runtime_dir / "server.pid"
    pid_file.write_text(f"{os.getpid()}\n", encoding="ascii")
    try:
        app = create_app(settings)
        uvicorn.run(
            app,
            host=settings.host,
            port=settings.port,
            log_level=settings.log_level,
            access_log=False,
        )
    finally:
        try:
            if pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                pid_file.unlink()
        except FileNotFoundError:
            pass


def _migrate(args: argparse.Namespace) -> None:
    settings = _settings_from_args(args)
    settings.ensure_directories()
    run_migrations(settings.database_path, settings.project_root)
    _json({"migrated": True, "database": str(settings.database_path)})


def _backup(args: argparse.Namespace) -> None:
    settings = _settings_from_args(args)
    _json(create_backup(settings.database_path, settings.backup_dir))


def _verify(args: argparse.Namespace) -> None:
    _json(verify_backup(Path(args.source)))


def _restore(args: argparse.Namespace) -> None:
    _json(restore_backup(Path(args.source), Path(args.destination)))


def _openai_check(args: argparse.Namespace) -> None:
    settings = _settings_from_args(args)
    _json(check_connection(settings))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="personal-asset-os")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Start the loopback HTTP application")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--data-dir", default=None)
    serve.set_defaults(handler=_serve)

    migrate = subparsers.add_parser("migrate", help="Apply database migrations")
    migrate.add_argument("--data-dir", default=None)
    migrate.set_defaults(handler=_migrate)

    build_id = subparsers.add_parser("build-id", help="Print the current source build id")
    build_id.set_defaults(handler=lambda args: print(source_build_id()))

    backup = subparsers.add_parser("backup", help="Create and verify a database backup")
    backup.add_argument("--data-dir", default=None)
    backup.set_defaults(handler=_backup)

    verify = subparsers.add_parser("verify-backup", help="Verify a backup database")
    verify.add_argument("--source", required=True)
    verify.set_defaults(handler=_verify)

    restore = subparsers.add_parser("restore-backup", help="Restore into a new destination")
    restore.add_argument("--source", required=True)
    restore.add_argument("--destination", required=True)
    restore.set_defaults(handler=_restore)

    openai_check = subparsers.add_parser(
        "openai-check",
        help="Make one minimal OpenAI call without sending personal finance data",
    )
    openai_check.set_defaults(handler=_openai_check)
    return parser


def main() -> NoReturn:
    parser = build_parser()
    args = parser.parse_args()
    args.handler(args)
    raise SystemExit(0)


if __name__ == "__main__":
    main()
