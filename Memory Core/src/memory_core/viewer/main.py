from __future__ import annotations

import tkinter as tk
import traceback
from pathlib import Path
from tkinter import messagebox


def main() -> int:
    from memory_core.viewer.client import ViewerApiClient
    from memory_core.viewer.settings import ViewerSettings

    try:
        settings = ViewerSettings.from_environment()
    except ValueError as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "Memory Core Control Center",
            f"{exc}\n\n請從系統托盤或 scripts\\start-memory-core-viewer.vbs 開啟。",
            parent=root,
        )
        root.destroy()
        return 2

    client = ViewerApiClient(
        base_url=settings.api_base_url,
        token=settings.token,
        timeout_seconds=settings.timeout_seconds,
    )
    root = tk.Tk()
    if settings.layout == "legacy":
        from memory_core.viewer.legacy_app import LegacyMemoryCoreViewer

        LegacyMemoryCoreViewer(root, client)
    else:
        from memory_core.viewer.app import MemoryCoreViewer

        MemoryCoreViewer(root, client)
    root.mainloop()
    return 0


def _write_fatal_error() -> Path | None:
    try:
        project_root = Path(__file__).resolve().parents[3]
        runtime_dir = project_root / "data" / "runtime"
        runtime_dir.mkdir(parents=True, exist_ok=True)
        log_path = runtime_dir / "memory-core-viewer-fatal.log"
        log_path.write_text(traceback.format_exc(), encoding="utf-8")
        return log_path
    except OSError:
        return None


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        fatal_log = _write_fatal_error()
        root = tk.Tk()
        root.withdraw()
        message = "控制中心發生無法復原的啟動錯誤。"
        if fatal_log is not None:
            message = f"{message}\n\n診斷紀錄：{fatal_log}"
        messagebox.showerror("Memory Core Control Center", message, parent=root)
        root.destroy()
        raise SystemExit(1) from None
