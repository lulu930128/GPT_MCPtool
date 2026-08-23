from __future__ import annotations

import uvicorn

from kgi_broker_bridge.runtime import create_runtime_app
from kgi_broker_bridge.settings import Settings


def main() -> None:
    settings = Settings()
    app = create_runtime_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=False,
    )


if __name__ == "__main__":
    main()
