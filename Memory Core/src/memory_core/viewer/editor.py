from __future__ import annotations

import json
import tkinter as tk
from tkinter import messagebox, ttk

from memory_core.viewer.client import JsonObject


def parse_json_object(value: str) -> JsonObject:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"JSON 格式錯誤：第 {exc.lineno} 行、第 {exc.colno} 欄，{exc.msg}"
        ) from exc
    if not isinstance(parsed, dict):
        raise ValueError("最外層必須是 JSON object。")
    return parsed


def record_create_document() -> JsonObject:
    return {
        "kind": "fact",
        "domain": "general",
        "title": "",
        "summary": None,
        "body_markdown": None,
        "occurred_start": None,
        "occurred_end": None,
        "date_precision": "unknown",
        "timezone_name": None,
        "importance": 50,
        "verification_status": "confirmed",
        "sensitivity": "personal",
        "handling_policy": "normal",
        "schema_name": "generic",
        "schema_version": 1,
        "payload": {},
        "source_type": "manual",
        "source_reference": None,
        "supersedes_id": None,
    }


def record_update_document(record: JsonObject) -> JsonObject:
    mutable_fields = (
        "title",
        "summary",
        "body_markdown",
        "occurred_start",
        "occurred_end",
        "date_precision",
        "timezone_name",
        "importance",
        "lifecycle_status",
        "verification_status",
        "sensitivity",
        "handling_policy",
        "schema_name",
        "schema_version",
        "payload",
        "source_reference",
        "supersedes_id",
    )
    document = {field: record.get(field) for field in mutable_fields}
    document["expected_version"] = record.get("version")
    document["change_reason"] = None
    return document


def entity_create_document() -> JsonObject:
    return {
        "entity_type": "person",
        "name": "",
        "canonical_name": None,
        "description": None,
        "payload": {},
        "sensitivity": "personal",
        "handling_policy": "normal",
    }


def entity_update_document(entity: JsonObject) -> JsonObject:
    mutable_fields = (
        "name",
        "canonical_name",
        "description",
        "payload",
        "sensitivity",
        "handling_policy",
    )
    document = {field: entity.get(field) for field in mutable_fields}
    document["expected_version"] = entity.get("version")
    document["change_reason"] = None
    return document


def media_experience_batch_document() -> JsonObject:
    return {
        "profile_id": "media.experience.v1",
        "profile_version": 1,
        "summary": "",
        "items": [
            {
                "client_item_id": "item-1",
                "work_title": "",
                "media_type": "galgame",
                "progress": "completed",
                "user_category": None,
                "completed_on": None,
                "aliases": [],
                "rating": None,
                "evaluation_note": None,
                "tags": [],
                "source_reference": None,
            }
        ],
        "source_type": "manual",
        "source_reference": "Memory Core Control Center",
        "idempotency_key": "",
        "confidence": 1,
        "risk_flags": [],
    }


class JsonDocumentDialog:
    def __init__(
        self,
        parent: tk.Misc,
        *,
        title: str,
        helper: str,
        document: JsonObject,
    ) -> None:
        self.result: JsonObject | None = None
        self._window = tk.Toplevel(parent)
        self._window.title(title)
        self._window.geometry("760x680")
        self._window.minsize(620, 520)
        self._window.transient(parent.winfo_toplevel())
        self._window.configure(bg="#F4F6F8")
        self._window.protocol("WM_DELETE_WINDOW", self._cancel)

        container = ttk.Frame(self._window, padding=18)
        container.pack(fill="both", expand=True)
        tk.Label(
            container,
            text=title,
            bg="#F4F6F8",
            fg="#172033",
            anchor="w",
            font=("Microsoft JhengHei UI", 16, "bold"),
        ).pack(fill="x")
        tk.Label(
            container,
            text=helper,
            bg="#F4F6F8",
            fg="#64748B",
            anchor="w",
            justify="left",
            wraplength=700,
            font=("Microsoft JhengHei UI", 9),
        ).pack(fill="x", pady=(4, 12))

        editor_frame = ttk.Frame(container)
        editor_frame.pack(fill="both", expand=True)
        self._editor = tk.Text(
            editor_frame,
            wrap="none",
            undo=True,
            bg="#FFFFFF",
            fg="#172033",
            insertbackground="#172033",
            relief="flat",
            padx=12,
            pady=12,
            font=("Consolas", 10),
        )
        y_scroll = ttk.Scrollbar(editor_frame, orient="vertical", command=self._editor.yview)
        x_scroll = ttk.Scrollbar(editor_frame, orient="horizontal", command=self._editor.xview)
        self._editor.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        self._editor.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        editor_frame.rowconfigure(0, weight=1)
        editor_frame.columnconfigure(0, weight=1)
        self._editor.insert(
            "1.0",
            json.dumps(document, ensure_ascii=False, indent=2, sort_keys=False),
        )

        actions = ttk.Frame(container)
        actions.pack(fill="x", pady=(14, 0))
        ttk.Button(actions, text="取消", command=self._cancel).pack(side="right")
        ttk.Button(
            actions,
            text="驗證並儲存",
            style="Primary.TButton",
            command=self._save,
        ).pack(side="right", padx=(0, 8))

        self._window.grab_set()
        self._editor.focus_set()

    @classmethod
    def show(
        cls,
        parent: tk.Misc,
        *,
        title: str,
        helper: str,
        document: JsonObject,
    ) -> JsonObject | None:
        dialog = cls(parent, title=title, helper=helper, document=document)
        parent.wait_window(dialog._window)
        return dialog.result

    def _save(self) -> None:
        try:
            self.result = parse_json_object(self._editor.get("1.0", "end-1c"))
        except ValueError as exc:
            messagebox.showerror(
                "JSON 驗證失敗",
                str(exc),
                parent=self._window,
            )
            return
        self._window.destroy()

    def _cancel(self) -> None:
        self.result = None
        self._window.destroy()
