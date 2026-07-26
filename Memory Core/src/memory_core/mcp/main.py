from __future__ import annotations

import uvicorn

from memory_core.mcp.runtime import build_runtime, create_http_app
from memory_core.mcp.settings import McpSettings


def main() -> None:
    settings = McpSettings()
    runtime = build_runtime(settings)
    app = create_http_app(runtime)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
