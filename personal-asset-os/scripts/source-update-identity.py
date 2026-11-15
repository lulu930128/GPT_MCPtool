"""Same build owner as CLI build-id, plus source-only Alembic head metadata."""

import argparse
import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

from personal_asset_os import __version__
from personal_asset_os.build import source_build_id
from personal_asset_os.migrations import code_only_schema_preflight

parser = argparse.ArgumentParser()
parser.add_argument("--frontend-dist", type=Path)
parser.add_argument("--schema-data-dir", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
if args.schema_data_dir is not None:
    database_path = args.schema_data_dir / "data" / "personal_asset_os.db"
    print(json.dumps(code_only_schema_preflight(database_path, root)))
    raise SystemExit(0)
config = Config(str(root / "alembic.ini"))
config.set_main_option("script_location", str(root / "migrations"))
heads = ScriptDirectory.from_config(config).get_heads()
if len(heads) != 1:
    raise RuntimeError("UPDATE_SCHEMA_HEAD_UNVERIFIED")
print(json.dumps({
    "version": __version__,
    "buildId": source_build_id(root, frontend_dist=args.frontend_dist),
    "schemaRevision": heads[0],
}))
