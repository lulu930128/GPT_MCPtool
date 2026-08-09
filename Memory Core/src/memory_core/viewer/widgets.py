from __future__ import annotations

import json
import tkinter as tk
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from tkinter import ttk
from typing import Any

from memory_core.viewer.theme import (
    ACCENT,
    ACCENT_SOFT,
    BORDER,
    FONT_UI,
    INK,
    MUTED,
    SURFACE,
    SURFACE_MUTED,
)


class NavigationButton(tk.Frame):
    def __init__(
        self,
        parent: tk.Misc,
        *,
        label: str,
        command: Callable[[], None],
    ) -> None:
        super().__init__(
            parent,
            bg=SURFACE,
            cursor="hand2",
            highlightthickness=0,
            takefocus=True,
        )
        self._command = command
        self._label = tk.Label(
            self,
            text=label,
            bg=SURFACE,
            fg=INK,
            anchor="w",
            padx=11,
            pady=8,
            font=(FONT_UI, 10),
            cursor="hand2",
        )
        self._label.pack(side="left", fill="both", expand=True)
        self._count = tk.Label(
            self,
            text="—",
            bg=SURFACE_MUTED,
            fg=MUTED,
            padx=7,
            pady=2,
            font=("Segoe UI", 9, "bold"),
            cursor="hand2",
        )
        self._count.pack(side="right", padx=(4, 9))
        for widget in (self, self._label, self._count):
            widget.bind("<Button-1>", self._activate)
        self.bind("<Return>", self._activate)
        self.bind("<space>", self._activate)

    def set_count(self, value: object) -> None:
        self._count.configure(text=str(value))

    def set_selected(self, selected: bool) -> None:
        background = ACCENT_SOFT if selected else SURFACE
        foreground = ACCENT if selected else INK
        font = (FONT_UI, 10, "bold" if selected else "normal")
        self.configure(bg=background)
        self._label.configure(bg=background, fg=foreground, font=font)
        self._count.configure(
            bg=ACCENT if selected else SURFACE_MUTED,
            fg="#FFFFFF" if selected else MUTED,
        )

    def _activate(self, _event: tk.Event[tk.Misc]) -> None:
        self.focus_set()
        self._command()


@dataclass(frozen=True)
class ResultListItem:
    target_type: str
    target_id: str
    title: str
    summary: str
    meta: str


class ResultListPanel(ttk.Frame):
    def __init__(
        self,
        parent: tk.Misc,
        *,
        on_open: Callable[[ResultListItem], None],
    ) -> None:
        super().__init__(parent)
        self._on_open = on_open
        self._items: list[ResultListItem] = []
        self._cards: list[tuple[tk.Frame, tuple[tk.Label, ...]]] = []
        self._selected_index: int | None = None

        self._canvas = tk.Canvas(
            self,
            bg=SURFACE,
            highlightthickness=0,
            takefocus=True,
        )
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=scrollbar.set)
        self._canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        self._content = tk.Frame(self._canvas, bg=SURFACE)
        self._window_id = self._canvas.create_window(
            (0, 0),
            window=self._content,
            anchor="nw",
        )
        self._content.bind("<Configure>", self._sync_scroll_region)
        self._canvas.bind("<Configure>", self._resize_content)
        self._canvas.bind("<Up>", partial(self._move_selection, -1))
        self._canvas.bind("<Down>", partial(self._move_selection, 1))
        self._canvas.bind("<Return>", self._open_selection)
        self._canvas.bind("<MouseWheel>", self._scroll)

    @property
    def selected_item(self) -> ResultListItem | None:
        if self._selected_index is None:
            return None
        if not 0 <= self._selected_index < len(self._items):
            return None
        return self._items[self._selected_index]

    def set_items(self, items: Sequence[ResultListItem]) -> None:
        for child in self._content.winfo_children():
            child.destroy()
        self._items = list(items)
        self._cards.clear()
        self._selected_index = None
        if not self._items:
            empty = tk.Frame(self._content, bg=SURFACE)
            empty.pack(fill="both", expand=True, padx=18, pady=28)
            tk.Label(
                empty,
                text="目前沒有可顯示的資料",
                bg=SURFACE,
                fg=INK,
                font=(FONT_UI, 11, "bold"),
            ).pack(anchor="w")
            tk.Label(
                empty,
                text="可切換分類、調整搜尋條件，或建立第一筆內容。",
                bg=SURFACE,
                fg=MUTED,
                font=(FONT_UI, 9),
            ).pack(anchor="w", pady=(5, 0))
            return

        for index, item in enumerate(self._items):
            card = tk.Frame(
                self._content,
                bg=SURFACE,
                cursor="hand2",
                highlightthickness=1,
                highlightbackground=BORDER,
            )
            card.pack(fill="x", padx=(0, 6), pady=(0, 7))
            title = tk.Label(
                card,
                text=item.title,
                bg=SURFACE,
                fg=INK,
                anchor="w",
                padx=11,
                pady=0,
                font=(FONT_UI, 10, "bold"),
                cursor="hand2",
            )
            title.pack(fill="x", pady=(9, 0))
            summary = tk.Label(
                card,
                text=item.summary,
                bg=SURFACE,
                fg=MUTED,
                anchor="w",
                padx=11,
                font=(FONT_UI, 9),
                cursor="hand2",
            )
            summary.pack(fill="x", pady=(2, 0))
            meta = tk.Label(
                card,
                text=item.meta,
                bg=SURFACE,
                fg="#718096",
                anchor="w",
                padx=11,
                font=(FONT_UI, 8),
                cursor="hand2",
            )
            meta.pack(fill="x", pady=(2, 8))
            labels = (title, summary, meta)
            self._cards.append((card, labels))
            callback = partial(self._select, index, True)
            wheel_callback = self._scroll
            for widget in (card, *labels):
                widget.bind("<Button-1>", callback)
                widget.bind("<MouseWheel>", wheel_callback)

    def _select(
        self,
        index: int,
        notify: bool,
        _event: tk.Event[tk.Misc] | None = None,
    ) -> None:
        if not 0 <= index < len(self._items):
            return
        self._selected_index = index
        self._canvas.focus_set()
        for card_index, (card, labels) in enumerate(self._cards):
            selected = card_index == index
            background = ACCENT_SOFT if selected else SURFACE
            card.configure(
                bg=background,
                highlightbackground=ACCENT if selected else BORDER,
                highlightthickness=2 if selected else 1,
            )
            for label in labels:
                label.configure(bg=background)
        card = self._cards[index][0]
        self._canvas.update_idletasks()
        self._canvas.yview_moveto(
            max(0.0, min(1.0, card.winfo_y() / max(1, self._content.winfo_height())))
        )
        if notify:
            self._on_open(self._items[index])

    def _move_selection(
        self,
        delta: int,
        _event: tk.Event[tk.Misc],
    ) -> str:
        if not self._items:
            return "break"
        current = self._selected_index if self._selected_index is not None else 0
        self._select(max(0, min(len(self._items) - 1, current + delta)), False)
        return "break"

    def _open_selection(self, _event: tk.Event[tk.Misc]) -> str:
        selected = self.selected_item
        if selected is not None:
            self._on_open(selected)
        return "break"

    def _scroll(self, event: tk.Event[tk.Misc]) -> str:
        delta = getattr(event, "delta", 0)
        self._canvas.yview_scroll(-1 if delta > 0 else 1, "units")
        return "break"

    def _sync_scroll_region(self, _event: tk.Event[tk.Misc]) -> None:
        self._canvas.configure(scrollregion=self._canvas.bbox("all"))

    def _resize_content(self, event: tk.Event[tk.Misc]) -> None:
        self._canvas.itemconfigure(self._window_id, width=event.width)


def _batch_item_title(item: Mapping[str, Any]) -> str:
    normalized = item.get("normalized_snapshot")
    if isinstance(normalized, Mapping):
        payload = normalized.get("payload")
        if isinstance(payload, Mapping) and payload.get("work_title"):
            return str(payload["work_title"])
        if normalized.get("work_title"):
            return str(normalized["work_title"])
    input_snapshot = item.get("input_snapshot")
    if isinstance(input_snapshot, Mapping) and input_snapshot.get("work_title"):
        return str(input_snapshot["work_title"])
    return str(item.get("unit_key") or item.get("id") or "未命名項目")


class BatchItemsPanel(ttk.Frame):
    """One-row-per-item review surface for a sealed batch plan."""

    def __init__(self, parent: tk.Misc) -> None:
        super().__init__(parent, style="Surface.TFrame")
        self._items: dict[str, Mapping[str, Any]] = {}
        self._summary_var = tk.StringVar(value="尚未載入批次項目")

        tk.Label(
            self,
            textvariable=self._summary_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 9),
        ).pack(fill="x", pady=(8, 5))

        panes = ttk.Panedwindow(self, orient="vertical")
        panes.pack(fill="both", expand=True, pady=(0, 8))
        table_holder = tk.Frame(panes, bg=SURFACE)
        detail_holder = tk.Frame(panes, bg=SURFACE)
        panes.add(table_holder, weight=3)
        panes.add(detail_holder, weight=2)

        columns = ("position", "title", "decision", "state", "retry", "error")
        self._tree = ttk.Treeview(
            table_holder,
            columns=columns,
            show="headings",
            selectmode="browse",
        )
        headings = (
            ("position", "#", 44),
            ("title", "項目", 220),
            ("decision", "計畫", 75),
            ("state", "執行狀態", 90),
            ("retry", "後續處理", 110),
            ("error", "錯誤", 150),
        )
        for column, label, width in headings:
            self._tree.heading(column, text=label)
            self._tree.column(column, width=width, minwidth=40, anchor="w")
        tree_scroll = ttk.Scrollbar(
            table_holder,
            orient="vertical",
            command=self._tree.yview,
        )
        self._tree.configure(yscrollcommand=tree_scroll.set)
        self._tree.pack(side="left", fill="both", expand=True)
        tree_scroll.pack(side="right", fill="y")
        self._tree.bind("<<TreeviewSelect>>", self._show_selected)

        self._detail = tk.Text(
            detail_holder,
            wrap="word",
            relief="flat",
            bg=SURFACE_MUTED,
            fg=INK,
            padx=11,
            pady=9,
            font=("Cascadia Mono", 9),
            state="disabled",
        )
        detail_scroll = ttk.Scrollbar(
            detail_holder,
            orient="vertical",
            command=self._detail.yview,
        )
        self._detail.configure(yscrollcommand=detail_scroll.set)
        self._detail.pack(side="left", fill="both", expand=True)
        detail_scroll.pack(side="right", fill="y")

    def set_batch(self, batch: Mapping[str, Any] | None) -> None:
        self._tree.delete(*self._tree.get_children())
        self._items.clear()
        if batch is None:
            self._summary_var.set("此候選不是批次資料")
            self._set_detail("")
            return

        raw_items = batch.get("items")
        items = (
            [item for item in raw_items if isinstance(item, Mapping)]
            if isinstance(raw_items, list)
            else []
        )
        summary = batch.get("execution_summary")
        if isinstance(summary, Mapping):
            self._summary_var.set(
                "共 {total} 筆 · 已套用 {applied} · 失敗 {failed} · "
                "待驗證 {unverified} · 待處理 {pending}".format(
                    total=summary.get("item_count", len(items)),
                    applied=summary.get("applied", 0),
                    failed=summary.get("failed", 0),
                    unverified=summary.get("unverified", 0),
                    pending=summary.get("pending", 0),
                )
            )
        else:
            self._summary_var.set(f"共 {len(items)} 筆批次項目")

        for fallback_position, item in enumerate(items, start=1):
            item_id = str(item.get("id") or f"item-{fallback_position}")
            self._items[item_id] = item
            plan_error = item.get("error_code")
            execution_error = item.get("execution_error_code")
            self._tree.insert(
                "",
                "end",
                iid=item_id,
                values=(
                    item.get("position", fallback_position),
                    _batch_item_title(item),
                    item.get("decision") or "—",
                    item.get("execution_state") or "not_started",
                    item.get("retry_policy") or "not_applicable",
                    execution_error or plan_error or "—",
                ),
            )
        children = self._tree.get_children()
        if children:
            self._tree.selection_set(children[0])
            self._tree.focus(children[0])
            self._show_selected()
        else:
            self._set_detail("批次目前沒有可顯示的項目。")

    def _show_selected(self, _event: tk.Event[tk.Misc] | None = None) -> None:
        selected = self._tree.selection()
        if not selected:
            self._set_detail("")
            return
        item = self._items.get(selected[0])
        if item is None:
            self._set_detail("")
            return
        detail = {
            "unit_key": item.get("unit_key"),
            "input": item.get("input_snapshot"),
            "normalized": item.get("normalized_snapshot"),
            "operations": item.get("operations"),
            "results": item.get("results"),
            "planning_error": {
                "code": item.get("error_code"),
                "message": item.get("error_message"),
            },
            "execution_error": {
                "code": item.get("execution_error_code"),
                "message": item.get("execution_error_message"),
                "retry_policy": item.get("retry_policy"),
            },
        }
        self._set_detail(json.dumps(detail, ensure_ascii=False, indent=2, default=str))

    def _set_detail(self, value: str) -> None:
        self._detail.configure(state="normal")
        self._detail.delete("1.0", "end")
        self._detail.insert("1.0", value)
        self._detail.configure(state="disabled")


class CollectionMembersPanel(ttk.Frame):
    """Collection members shown as independently openable records."""

    def __init__(
        self,
        parent: tk.Misc,
        *,
        on_open_record: Callable[[str], None],
    ) -> None:
        super().__init__(parent, style="Surface.TFrame")
        self._on_open_record = on_open_record
        self._record_ids: dict[str, str] = {}
        self._summary_var = tk.StringVar(value="尚未載入清單項目")

        tk.Label(
            self,
            textvariable=self._summary_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 9),
        ).pack(fill="x", pady=(8, 5))
        columns = ("position", "title", "domain", "updated")
        self._tree = ttk.Treeview(
            self,
            columns=columns,
            show="headings",
            selectmode="browse",
        )
        headings = (
            ("position", "#", 48),
            ("title", "記憶", 260),
            ("domain", "領域", 160),
            ("updated", "更新時間", 150),
        )
        for column, label, width in headings:
            self._tree.heading(column, text=label)
            self._tree.column(column, width=width, minwidth=45, anchor="w")
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=self._tree.yview)
        self._tree.configure(yscrollcommand=scrollbar.set)
        self._tree.pack(side="left", fill="both", expand=True, pady=(0, 8))
        scrollbar.pack(side="right", fill="y", pady=(0, 8))
        self._tree.bind("<Double-1>", self._open_selected)
        self._tree.bind("<Return>", self._open_selected)

    def set_collection(self, collection: Mapping[str, Any] | None) -> None:
        self._tree.delete(*self._tree.get_children())
        self._record_ids.clear()
        if collection is None:
            self._summary_var.set("此處會顯示清單中的每一筆記憶")
            return
        raw_members = collection.get("members")
        members = (
            [member for member in raw_members if isinstance(member, Mapping)]
            if isinstance(raw_members, list)
            else []
        )
        total = collection.get("member_count", len(members))
        self._summary_var.set(f"顯示 {len(members)} / {total} 筆；雙擊或按 Enter 開啟單筆記憶")
        for fallback_position, member in enumerate(members, start=1):
            record = member.get("record")
            if not isinstance(record, Mapping) or not record.get("id"):
                continue
            record_id = str(record["id"])
            row_id = f"member-{fallback_position}-{record_id}"
            self._record_ids[row_id] = record_id
            self._tree.insert(
                "",
                "end",
                iid=row_id,
                values=(
                    member.get("position") or fallback_position,
                    record.get("title") or "未命名記憶",
                    record.get("domain") or "未分類",
                    str(record.get("updated_at") or "—"),
                ),
            )

    def _open_selected(self, _event: tk.Event[tk.Misc]) -> str:
        selected = self._tree.selection()
        if selected:
            record_id = self._record_ids.get(selected[0])
            if record_id:
                self._on_open_record(record_id)
        return "break"


class KeyValueSection(ttk.Frame):
    def __init__(self, parent: tk.Misc) -> None:
        super().__init__(parent, style="Surface.TFrame")
        self._value_labels: list[tk.Label] = []
        self._copy_menu = tk.Menu(self, tearoff=False)
        self.bind("<Configure>", self._resize_values)

    def set_rows(self, rows: Sequence[tuple[str, str]]) -> None:
        for child in self.winfo_children():
            child.destroy()
        self._value_labels.clear()
        self.columnconfigure(0, minsize=110)
        self.columnconfigure(1, weight=1)
        for row_index, (label, value) in enumerate(rows):
            tk.Label(
                self,
                text=label,
                bg=SURFACE,
                fg=MUTED,
                anchor="nw",
                font=(FONT_UI, 9, "bold"),
            ).grid(row=row_index, column=0, sticky="nw", padx=(0, 12), pady=4)
            value_label = tk.Label(
                self,
                text=value,
                bg=SURFACE,
                fg=INK,
                anchor="nw",
                justify="left",
                wraplength=360,
                cursor="hand2",
                font=(FONT_UI, 9),
            )
            value_label.grid(row=row_index, column=1, sticky="new", pady=4)
            value_label.bind("<Button-3>", partial(self._show_copy_menu, value))
            self._value_labels.append(value_label)

    def _show_copy_menu(
        self,
        value: str,
        event: tk.Event[tk.Misc],
    ) -> None:
        self._copy_menu.delete(0, "end")
        self._copy_menu.add_command(label="複製內容", command=partial(self._copy_value, value))
        self._copy_menu.tk_popup(event.x_root, event.y_root)

    def _copy_value(self, value: str) -> None:
        self.clipboard_clear()
        self.clipboard_append(value)

    def _resize_values(self, event: tk.Event[tk.Misc]) -> None:
        wraplength = max(180, event.width - 132)
        for label in self._value_labels:
            label.configure(wraplength=wraplength)
