"""Public code identity only; no Settings, database, token or runtime initialization."""

import json

from memory_core import __version__
from memory_core.build import source_build_id

print(json.dumps({"version": __version__, "buildId": source_build_id()}))
