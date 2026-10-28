"""Same build owner as CLI build-id, plus source-only Alembic head metadata."""

import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

from personal_asset_os import __version__
from personal_asset_os.build import source_build_id

root = Path(__file__).resolve().parents[1]
config = Config(str(root / "alembic.ini"))
config.set_main_option("script_location", str(root / "migrations"))
heads = ScriptDirectory.from_config(config).get_heads()
if len(heads) != 1:
    raise RuntimeError("UPDATE_SCHEMA_HEAD_UNVERIFIED")
print(json.dumps({
    "version": __version__, "buildId": source_build_id(root), "schemaRevision": heads[0],
}))
