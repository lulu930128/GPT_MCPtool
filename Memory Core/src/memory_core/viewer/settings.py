from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse


@dataclass(frozen=True)
class ViewerSettings:
    api_base_url: str
    token: str
    timeout_seconds: float
    layout: Literal["v2", "legacy"]

    @classmethod
    def from_environment(cls) -> ViewerSettings:
        base_url = os.getenv(
            "MEMORY_CORE_CONTROL_CENTER_API_BASE_URL",
            "http://127.0.0.1:18765",
        )
        token = os.environ.pop("MEMORY_CORE_CONTROL_CENTER_TOKEN", "")
        os.environ.pop("MEMORY_CORE_VIEWER_TOKEN", None)
        timeout_raw = os.getenv(
            "MEMORY_CORE_CONTROL_CENTER_TIMEOUT_SECONDS",
            "8",
        )
        layout_raw = os.getenv("MEMORY_CORE_VIEWER_LAYOUT", "v2").strip().lower()

        parsed = urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("控制中心 API 必須使用本機 loopback HTTP URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("控制中心 API URL 不得包含 credential、query 或 fragment")
        if not token.startswith("mcore_"):
            raise ValueError("找不到有效的 Memory Core 控制中心 credential")
        try:
            timeout_seconds = float(timeout_raw)
        except ValueError as exc:
            raise ValueError("控制中心 timeout 必須是數字") from exc
        if not 1 <= timeout_seconds <= 60:
            raise ValueError("控制中心 timeout 必須介於 1 到 60 秒")
        if layout_raw not in {"v2", "legacy"}:
            raise ValueError("MEMORY_CORE_VIEWER_LAYOUT 只接受 v2 或 legacy")
        layout: Literal["v2", "legacy"] = "legacy" if layout_raw == "legacy" else "v2"
        return cls(
            api_base_url=base_url.rstrip("/"),
            token=token,
            timeout_seconds=timeout_seconds,
            layout=layout,
        )
