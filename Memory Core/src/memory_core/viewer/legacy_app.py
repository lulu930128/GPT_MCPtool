from __future__ import annotations

import tkinter as tk
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from tkinter import messagebox, simpledialog, ttk
from typing import Literal, TypeVar

from memory_core.viewer.client import JsonObject, ViewerApiClient, ViewerApiError
from memory_core.viewer.editor import (
    JsonDocumentDialog,
    entity_create_document,
    entity_update_document,
    record_create_document,
    record_update_document,
)
from memory_core.viewer.presentation import (
    candidate_display_title,
    category_counts,
    compact_text,
    display_identifier,
    entity_summary_lines,
    filter_by_category,
    format_summary,
    pretty_json,
    record_summary_lines,
)

T = TypeVar("T")

BG = "#F4F6F8"
SURFACE = "#FFFFFF"
INK = "#172033"
MUTED = "#64748B"
NAVY = "#14213D"
ACCENT = "#0F766E"
ACCENT_HOVER = "#115E59"
BORDER = "#DCE2E8"
SOFT_TEAL = "#E7F6F3"
SOFT_AMBER = "#FFF5D9"
ERROR = "#B42318"


class LegacyMemoryCoreViewer:
    def __init__(self, root: tk.Tk, client: ViewerApiClient) -> None:
        self._root = root
        self._client = client
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="memory-viewer")
        self._active_requests = 0
        self._closing = False
        self._current_view = "records"
        self._row_targets: dict[str, tuple[str, str]] = {}
        self._selected_record_id: str | None = None
        self._selected_detail_type: str | None = None
        self._selected_detail: JsonObject | None = None
        self._prepared_review: JsonObject | None = None
        self._detail_request_serial = 0
        self._all_result_rows: list[JsonObject] = []
        self._category_key = "domain"
        self._category_mode = "records"
        self._category_values: dict[str, str | None] = {}
        self._selected_category: str | None = None
        self._base_result_heading = "Records"
        self._configuring_categories = False

        self._status_var = tk.StringVar(value="正在連線到 Memory Core…")
        self._connection_var = tk.StringVar(value="CHECKING")
        self._records_metric = tk.StringVar(value="—")
        self._entities_metric = tk.StringVar(value="—")
        self._domains_metric = tk.StringVar(value="—")
        self._index_metric = tk.StringVar(value="—")
        self._candidates_metric = tk.StringVar(value="—")
        self._result_heading_var = tk.StringVar(value="Records")
        self._result_count_var = tk.StringVar(value="尚未載入")
        self._category_heading_var = tk.StringVar(value="領域分類")
        self._category_helper_var = tk.StringVar(value="依 domain 瀏覽")
        self._search_var = tk.StringVar()
        self._include_archived_var = tk.BooleanVar(value=False)
        self._detail_title_var = tk.StringVar(value="選取一筆資料")
        self._detail_meta_var = tk.StringVar(value="從中間清單選取資料即可查看完整內容")

        self._configure_window()
        self._configure_styles()
        self._build_layout()
        self._root.protocol("WM_DELETE_WINDOW", self._close)
        self._root.after(120, self.refresh_all)

    def _configure_window(self) -> None:
        self._root.title("Memory Core Control Center")
        self._root.geometry("1400x840")
        self._root.minsize(1080, 680)
        self._root.configure(bg=BG)

    def _configure_styles(self) -> None:
        style = ttk.Style(self._root)
        style.theme_use("clam")
        style.configure(".", font=("Microsoft JhengHei UI", 10), foreground=INK)
        style.configure("App.TFrame", background=BG)
        style.configure("Surface.TFrame", background=SURFACE)
        style.configure("Toolbar.TFrame", background=SURFACE)
        style.configure(
            "Primary.TButton",
            background=ACCENT,
            foreground="#FFFFFF",
            bordercolor=ACCENT,
            padding=(15, 8),
            font=("Microsoft JhengHei UI", 10, "bold"),
        )
        style.map(
            "Primary.TButton",
            background=[("active", ACCENT_HOVER), ("disabled", "#94A3B8")],
            bordercolor=[("active", ACCENT_HOVER)],
        )
        style.configure(
            "Danger.TButton",
            background="#B42318",
            foreground="#FFFFFF",
            bordercolor="#B42318",
            padding=(12, 7),
            font=("Microsoft JhengHei UI", 9, "bold"),
        )
        style.map(
            "Danger.TButton",
            background=[("active", "#912018"), ("disabled", "#CBD5E1")],
            bordercolor=[("active", "#912018")],
        )
        style.configure(
            "Nav.TButton",
            background=SURFACE,
            foreground=MUTED,
            borderwidth=0,
            padding=(14, 9),
        )
        style.map("Nav.TButton", background=[("active", "#EDF2F7")], foreground=[("active", INK)])
        style.configure(
            "NavSelected.TButton",
            background=SOFT_TEAL,
            foreground=ACCENT,
            borderwidth=0,
            padding=(14, 9),
            font=("Microsoft JhengHei UI", 10, "bold"),
        )
        style.configure(
            "Treeview",
            background=SURFACE,
            fieldbackground=SURFACE,
            foreground=INK,
            rowheight=34,
            bordercolor=BORDER,
            lightcolor=BORDER,
            darkcolor=BORDER,
        )
        style.configure(
            "Treeview.Heading",
            background="#EEF2F6",
            foreground="#475569",
            padding=(8, 8),
            font=("Microsoft JhengHei UI", 9, "bold"),
            borderwidth=0,
        )
        style.map("Treeview", background=[("selected", "#D7EEEA")], foreground=[("selected", INK)])
        style.configure(
            "Category.Treeview",
            background="#F8FAFC",
            fieldbackground="#F8FAFC",
            foreground=INK,
            rowheight=36,
            bordercolor=BORDER,
            lightcolor=BORDER,
            darkcolor=BORDER,
        )
        style.configure(
            "Category.Treeview.Heading",
            background="#E9EEF3",
            foreground="#475569",
            padding=(7, 7),
            font=("Microsoft JhengHei UI", 9, "bold"),
            borderwidth=0,
        )
        style.map(
            "Category.Treeview",
            background=[("selected", ACCENT)],
            foreground=[("selected", "#FFFFFF")],
        )
        style.configure("TNotebook", background=SURFACE, borderwidth=0)
        style.configure(
            "TNotebook.Tab",
            background="#EEF2F6",
            foreground=MUTED,
            padding=(13, 8),
            borderwidth=0,
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", SURFACE)],
            foreground=[("selected", ACCENT)],
        )
        style.configure("TCheckbutton", background=SURFACE, foreground=MUTED)
        style.configure("TEntry", padding=(8, 7), fieldbackground="#FAFBFC", bordercolor=BORDER)

    def _build_layout(self) -> None:
        container = ttk.Frame(self._root, style="App.TFrame", padding=(18, 0, 18, 12))
        container.pack(fill="both", expand=True)
        self._build_header(container)
        self._build_metrics(container)
        self._build_toolbar(container)
        self._build_workspace(container)
        self._build_status_bar(container)

    def _build_header(self, parent: ttk.Frame) -> None:
        header = tk.Frame(parent, bg=NAVY, height=86)
        header.pack(fill="x", pady=(0, 14))
        header.pack_propagate(False)

        brand = tk.Frame(header, bg=NAVY)
        brand.pack(side="left", fill="y", padx=22)
        tk.Label(
            brand,
            text="MEMORY CORE",
            bg=NAVY,
            fg="#86E5D7",
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor="w", pady=(17, 0))
        tk.Label(
            brand,
            text="Personal memory control center",
            bg=NAVY,
            fg="#FFFFFF",
            font=("Microsoft JhengHei UI", 18, "bold"),
        ).pack(anchor="w", pady=(1, 0))

        connection = tk.Frame(header, bg=NAVY)
        connection.pack(side="right", fill="y", padx=22)
        tk.Label(
            connection,
            textvariable=self._connection_var,
            bg="#223155",
            fg="#BDEFE7",
            padx=12,
            pady=5,
            font=("Segoe UI", 9, "bold"),
        ).pack(anchor="e", pady=(22, 3))
        tk.Label(
            connection,
            text="LOCAL ADMIN · loopback API · audited writes",
            bg=NAVY,
            fg="#AEB9CC",
            font=("Microsoft JhengHei UI", 9),
        ).pack(anchor="e")

    def _build_metrics(self, parent: ttk.Frame) -> None:
        metrics = ttk.Frame(parent, style="App.TFrame")
        metrics.pack(fill="x", pady=(0, 12))
        for index in range(5):
            metrics.columnconfigure(index, weight=1)
        cards = (
            ("VISIBLE RECORDS", self._records_metric, "active / superseded / archived", SOFT_TEAL),
            ("VISIBLE ENTITIES", self._entities_metric, "active / archived", "#EDF3FF"),
            ("DOMAINS", self._domains_metric, "目前可見分類", SOFT_AMBER),
            ("SEARCH INDEX", self._index_metric, "indexed / searchable", "#F1ECFF"),
            ("CANDIDATES", self._candidates_metric, "pending / conflict", "#FDECEC"),
        )
        for column, (label, variable, helper, color) in enumerate(cards):
            card = tk.Frame(metrics, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
            card.grid(
                row=0,
                column=column,
                sticky="nsew",
                padx=(0 if column == 0 else 4, 0 if column == 4 else 4),
            )
            stripe = tk.Frame(card, bg=color, width=7)
            stripe.pack(side="left", fill="y")
            body = tk.Frame(card, bg=SURFACE)
            body.pack(fill="both", expand=True, padx=14, pady=10)
            tk.Label(
                body,
                text=label,
                bg=SURFACE,
                fg=MUTED,
                font=("Segoe UI", 8, "bold"),
            ).pack(anchor="w")
            tk.Label(
                body,
                textvariable=variable,
                bg=SURFACE,
                fg=INK,
                font=("Segoe UI", 19, "bold"),
            ).pack(anchor="w", pady=(2, 0))
            tk.Label(
                body,
                text=helper,
                bg=SURFACE,
                fg="#94A3B8",
                font=("Microsoft JhengHei UI", 8),
            ).pack(anchor="w")

    def _build_toolbar(self, parent: ttk.Frame) -> None:
        toolbar = ttk.Frame(parent, style="Toolbar.TFrame", padding=(12, 10))
        toolbar.pack(fill="x", pady=(0, 12))

        self._records_button = ttk.Button(
            toolbar,
            text="Records",
            style="NavSelected.TButton",
            command=lambda: self._switch_view("records"),
        )
        self._records_button.pack(side="left")
        self._entities_button = ttk.Button(
            toolbar,
            text="Entities",
            style="Nav.TButton",
            command=lambda: self._switch_view("entities"),
        )
        self._entities_button.pack(side="left", padx=(4, 0))
        self._candidates_button = ttk.Button(
            toolbar,
            text="Candidates",
            style="Nav.TButton",
            command=lambda: self._switch_view("candidates"),
        )
        self._candidates_button.pack(side="left", padx=(4, 0))

        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=12)
        self._search_entry = ttk.Entry(toolbar, textvariable=self._search_var, width=30)
        self._search_entry.pack(side="left", fill="x", expand=True)
        self._search_entry.bind("<Return>", lambda _event: self._run_search())
        self._search_button = ttk.Button(
            toolbar,
            text="搜尋",
            style="Primary.TButton",
            command=self._run_search,
        )
        self._search_button.pack(side="left", padx=(8, 12))
        self._archived_check = ttk.Checkbutton(
            toolbar,
            text="包含已封存",
            variable=self._include_archived_var,
            command=self._reload_current_view,
        )
        self._archived_check.pack(side="left", padx=(0, 10))
        ttk.Button(toolbar, text="重新整理", command=self.refresh_all).pack(side="left")
        ttk.Button(toolbar, text="JSON 匯出", command=self._export_json).pack(
            side="left",
            padx=(10, 0),
        )
        ttk.Button(toolbar, text="SQLite 備份", command=self._backup_sqlite).pack(
            side="left",
            padx=(6, 0),
        )

    def _build_workspace(self, parent: ttk.Frame) -> None:
        workspace = ttk.Panedwindow(parent, orient="horizontal")
        workspace.pack(fill="both", expand=True)

        list_panel = ttk.Frame(workspace, style="Surface.TFrame", padding=12)
        detail_panel = ttk.Frame(workspace, style="Surface.TFrame", padding=12)
        workspace.add(list_panel, weight=4)
        workspace.add(detail_panel, weight=7)

        list_heading = ttk.Frame(list_panel, style="Surface.TFrame")
        list_heading.pack(fill="x", pady=(0, 9))
        tk.Label(
            list_heading,
            textvariable=self._result_heading_var,
            bg=SURFACE,
            fg=INK,
            font=("Microsoft JhengHei UI", 15, "bold"),
        ).pack(side="left")
        tk.Label(
            list_heading,
            textvariable=self._result_count_var,
            bg=SURFACE,
            fg=MUTED,
            font=("Microsoft JhengHei UI", 9),
        ).pack(side="right")

        browser = ttk.Panedwindow(list_panel, orient="horizontal")
        browser.pack(fill="both", expand=True)

        category_panel = tk.Frame(
            browser,
            bg="#F8FAFC",
            width=185,
            highlightthickness=1,
            highlightbackground=BORDER,
        )
        table_frame = ttk.Frame(browser, style="Surface.TFrame")
        browser.add(category_panel, weight=0)
        browser.add(table_frame, weight=1)

        category_header = tk.Frame(category_panel, bg="#F8FAFC")
        category_header.pack(fill="x", padx=10, pady=(10, 8))
        tk.Label(
            category_header,
            textvariable=self._category_heading_var,
            bg="#F8FAFC",
            fg=INK,
            anchor="w",
            font=("Microsoft JhengHei UI", 11, "bold"),
        ).pack(fill="x")
        tk.Label(
            category_header,
            textvariable=self._category_helper_var,
            bg="#F8FAFC",
            fg=MUTED,
            anchor="w",
            font=("Microsoft JhengHei UI", 8),
        ).pack(fill="x", pady=(2, 0))

        category_tree_frame = tk.Frame(category_panel, bg="#F8FAFC")
        category_tree_frame.pack(fill="both", expand=True, padx=(8, 3), pady=(0, 8))
        self._category_tree = ttk.Treeview(
            category_tree_frame,
            columns=("count",),
            show="tree headings",
            selectmode="browse",
            style="Category.Treeview",
        )
        self._category_tree.heading("#0", text="分類")
        self._category_tree.heading("count", text="筆數")
        self._category_tree.column("#0", width=132, minwidth=92, anchor="w")
        self._category_tree.column("count", width=42, minwidth=38, anchor="e")
        category_scroll = ttk.Scrollbar(
            category_tree_frame,
            orient="vertical",
            command=self._category_tree.yview,
        )
        self._category_tree.configure(yscrollcommand=category_scroll.set)
        self._category_tree.pack(side="left", fill="both", expand=True)
        category_scroll.pack(side="right", fill="y")
        self._category_tree.bind("<<TreeviewSelect>>", self._on_category_selected)

        self._result_tree = ttk.Treeview(table_frame, show="headings", selectmode="browse")
        result_scroll_y = ttk.Scrollbar(
            table_frame,
            orient="vertical",
            command=self._result_tree.yview,
        )
        self._result_tree.configure(yscrollcommand=result_scroll_y.set)
        self._result_tree.grid(row=0, column=0, sticky="nsew", padx=(8, 0))
        result_scroll_y.grid(row=0, column=1, sticky="ns")
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)
        self._result_tree.bind("<<TreeviewSelect>>", self._on_result_selected)
        self._result_tree.bind("<Return>", lambda _event: self._open_selected())

        detail_heading = ttk.Frame(detail_panel, style="Surface.TFrame")
        detail_heading.pack(fill="x", pady=(0, 8))
        detail_text = tk.Frame(detail_heading, bg=SURFACE)
        detail_text.pack(side="left", fill="x", expand=True)
        tk.Label(
            detail_text,
            textvariable=self._detail_title_var,
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=("Microsoft JhengHei UI", 15, "bold"),
        ).pack(fill="x")
        tk.Label(
            detail_text,
            textvariable=self._detail_meta_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=("Microsoft JhengHei UI", 9),
        ).pack(fill="x", pady=(2, 0))
        self._detail_actions = ttk.Frame(detail_heading, style="Surface.TFrame")
        self._detail_actions.pack(side="right", padx=(12, 0))
        self._new_button = ttk.Button(
            self._detail_actions,
            text="新增",
            style="Primary.TButton",
            command=self._create_current,
        )
        self._edit_button = ttk.Button(
            self._detail_actions,
            text="編輯",
            command=self._edit_selected,
        )
        self._archive_button = ttk.Button(
            self._detail_actions,
            text="刪除",
            style="Danger.TButton",
            command=self._archive_selected,
        )
        self._prepare_button = ttk.Button(
            self._detail_actions,
            text="準備審核",
            command=self._prepare_candidate_review,
        )
        self._approve_button = ttk.Button(
            self._detail_actions,
            text="核准並寫入",
            style="Primary.TButton",
            command=self._approve_candidate,
        )
        self._reject_button = ttk.Button(
            self._detail_actions,
            text="拒絕",
            style="Danger.TButton",
            command=self._reject_candidate,
        )
        self._refresh_detail_actions()

        self._detail_notebook = ttk.Notebook(detail_panel)
        self._detail_notebook.pack(fill="both", expand=True)
        self._summary_text = self._add_text_tab("摘要")
        self._content_text = self._add_text_tab("內容")
        self._payload_text = self._add_text_tab("Payload")
        self._links_tab = ttk.Frame(self._detail_notebook, style="Surface.TFrame", padding=8)
        self._detail_notebook.add(self._links_tab, text="Links")
        self._build_links_tab()
        self._revision_tab = ttk.Frame(self._detail_notebook, style="Surface.TFrame", padding=8)
        self._detail_notebook.add(self._revision_tab, text="Revisions")
        self._build_revision_tab()
        self._raw_text = self._add_text_tab("原始 JSON")

    def _add_text_tab(self, title: str) -> tk.Text:
        frame = ttk.Frame(self._detail_notebook, style="Surface.TFrame", padding=8)
        self._detail_notebook.add(frame, text=title)
        text = tk.Text(
            frame,
            wrap="word",
            relief="flat",
            bg="#FBFCFD",
            fg=INK,
            insertbackground=INK,
            padx=12,
            pady=12,
            spacing1=2,
            spacing3=3,
            font=("Microsoft JhengHei UI", 10),
        )
        scrollbar = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
        text.configure(yscrollcommand=scrollbar.set, state="disabled")
        text.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        return text

    def _build_links_tab(self) -> None:
        self._link_tree = ttk.Treeview(
            self._links_tab,
            columns=("direction", "role", "target", "revision", "status"),
            show="headings",
        )
        headings = (
            ("direction", "方向", 72),
            ("role", "Role", 130),
            ("target", "Target", 230),
            ("revision", "Revision", 76),
            ("status", "狀態", 76),
        )
        for column, label, width in headings:
            self._link_tree.heading(column, text=label)
            self._link_tree.column(column, width=width, minwidth=60, anchor="w")
        scrollbar = ttk.Scrollbar(
            self._links_tab,
            orient="vertical",
            command=self._link_tree.yview,
        )
        self._link_tree.configure(yscrollcommand=scrollbar.set)
        self._link_tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

    def _build_revision_tab(self) -> None:
        revision_list_frame = ttk.Frame(self._revision_tab, style="Surface.TFrame")
        revision_list_frame.pack(side="left", fill="y", padx=(0, 8))
        tk.Label(
            revision_list_frame,
            text="歷史版本",
            bg=SURFACE,
            fg=MUTED,
            font=("Microsoft JhengHei UI", 9, "bold"),
        ).pack(anchor="w", pady=(0, 5))
        self._revision_list = tk.Listbox(
            revision_list_frame,
            width=15,
            relief="flat",
            bg="#F4F7F9",
            fg=INK,
            selectbackground="#D7EEEA",
            selectforeground=INK,
            exportselection=False,
            font=("Segoe UI", 10),
        )
        self._revision_list.pack(fill="y", expand=True)
        self._revision_list.bind("<<ListboxSelect>>", self._open_revision)

        revision_detail_frame = ttk.Frame(self._revision_tab, style="Surface.TFrame")
        revision_detail_frame.pack(side="left", fill="both", expand=True)
        self._revision_text = tk.Text(
            revision_detail_frame,
            wrap="word",
            relief="flat",
            bg="#FBFCFD",
            fg=INK,
            padx=12,
            pady=12,
            font=("Consolas", 9),
            state="disabled",
        )
        scrollbar = ttk.Scrollbar(
            revision_detail_frame,
            orient="vertical",
            command=self._revision_text.yview,
        )
        self._revision_text.configure(yscrollcommand=scrollbar.set)
        self._revision_text.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

    def _build_status_bar(self, parent: ttk.Frame) -> None:
        bar = tk.Frame(parent, bg=BG)
        bar.pack(fill="x", pady=(8, 0))
        tk.Label(
            bar,
            textvariable=self._status_var,
            bg=BG,
            fg=MUTED,
            anchor="w",
            font=("Microsoft JhengHei UI", 9),
        ).pack(side="left", fill="x", expand=True)
        tk.Label(
            bar,
            text="LOCAL ADMIN",
            bg=BG,
            fg=ACCENT,
            font=("Segoe UI", 9, "bold"),
        ).pack(side="right")

    def refresh_all(self) -> None:
        self._submit("讀取系統概況", self._load_status, self._apply_status)
        self._reload_current_view()

    def _load_status(self) -> tuple[JsonObject, JsonObject, JsonObject]:
        return (
            self._client.health(),
            self._client.overview(),
            self._client.candidate_stats(),
        )

    def _apply_status(self, result: tuple[JsonObject, JsonObject, JsonObject]) -> None:
        health, overview, candidate_stats = result
        healthy = health.get("status") == "ok" and health.get("database") == "ok"
        self._connection_var.set("CONNECTED" if healthy else "DEGRADED")
        records = overview.get("records", {})
        entities = overview.get("entities", {})
        index = overview.get("index", {})
        if isinstance(records, dict):
            self._records_metric.set(
                f"{records.get('active', 0)} / {records.get('superseded', 0)} / "
                f"{records.get('archived', 0)}"
            )
        if isinstance(entities, dict):
            self._entities_metric.set(
                f"{entities.get('active', 0)} / {entities.get('archived', 0)}"
            )
        domains = overview.get("domains", {})
        self._domains_metric.set(str(len(domains)) if isinstance(domains, dict) else "—")
        if isinstance(index, dict):
            self._index_metric.set(
                f"{index.get('indexed_records', 0)} / {index.get('searchable_records', 0)}"
            )
        self._candidates_metric.set(
            f"{candidate_stats.get('pending', 0)} / {candidate_stats.get('conflict', 0)}"
        )

    def _switch_view(self, view: str) -> None:
        self._current_view = view
        self._search_var.set("")
        self._records_button.configure(
            style="NavSelected.TButton" if view == "records" else "Nav.TButton"
        )
        self._entities_button.configure(
            style="NavSelected.TButton" if view == "entities" else "Nav.TButton"
        )
        self._candidates_button.configure(
            style="NavSelected.TButton" if view == "candidates" else "Nav.TButton"
        )
        candidate_mode = view == "candidates"
        self._search_entry.configure(state="disabled" if candidate_mode else "normal")
        self._search_button.configure(state="disabled" if candidate_mode else "normal")
        self._archived_check.configure(state="disabled" if candidate_mode else "normal")
        self._reset_detail_view()
        self._reload_current_view()

    def _reload_current_view(self) -> None:
        if self._search_var.get().strip():
            self._run_search()
        include_deleted = self._include_archived_var.get()
        if self._search_var.get().strip():
            return
        if self._current_view == "candidates":
            self._submit(
                "讀取 Candidates",
                self._client.list_candidates,
                self._render_candidates,
            )
        elif self._current_view == "entities":
            self._submit(
                "讀取 Entities",
                lambda: self._client.list_entities(include_deleted=include_deleted),
                self._render_entities,
            )
        else:
            self._submit(
                "讀取 Records",
                lambda: self._client.list_records(include_deleted=include_deleted),
                self._render_records,
            )

    def _run_search(self) -> None:
        query = self._search_var.get().strip()
        if not query:
            self._reload_current_view()
            return
        self._current_view = "search"
        self._records_button.configure(style="Nav.TButton")
        self._entities_button.configure(style="Nav.TButton")
        self._candidates_button.configure(style="Nav.TButton")
        self._submit(
            f"搜尋「{compact_text(query, limit=32)}」",
            lambda: self._client.search(query),
            lambda rows: self._render_search(query, rows),
        )

    def _configure_result_columns(
        self,
        columns: tuple[
            tuple[str, str, int, Literal["w", "center", "e"]],
            ...,
        ],
    ) -> None:
        names = tuple(column[0] for column in columns)
        self._result_tree.configure(columns=names)
        for name, label, width, anchor in columns:
            self._result_tree.heading(name, text=label)
            self._result_tree.column(name, width=width, minwidth=60, anchor=anchor)

    def _clear_results(self) -> None:
        self._result_tree.delete(*self._result_tree.get_children())
        self._row_targets.clear()

    def _render_records(self, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="records",
            key="domain",
            heading="Records",
            category_heading="領域分類",
            category_helper="依 domain 瀏覽",
        )

    def _render_entities(self, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="entities",
            key="entity_type",
            heading="Entities",
            category_heading="Entity 類型",
            category_helper="依 entity_type 瀏覽",
        )

    def _render_search(self, query: str, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="search",
            key="result_type",
            heading=f"搜尋：{compact_text(query, limit=40)}",
            category_heading="搜尋類型",
            category_helper="Records / Entities",
        )

    def _render_candidates(self, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="candidates",
            key="status",
            heading="Candidates",
            category_heading="審核狀態",
            category_helper="pending / applied / rejected",
        )

    def _set_category_rows(
        self,
        rows: list[JsonObject],
        *,
        mode: str,
        key: str,
        heading: str,
        category_heading: str,
        category_helper: str,
    ) -> None:
        preserved_category = self._selected_category if self._category_mode == mode else None
        self._all_result_rows = list(rows)
        self._category_mode = mode
        self._category_key = key
        self._base_result_heading = heading
        self._category_heading_var.set(category_heading)
        self._category_helper_var.set(category_helper)

        counts = category_counts(self._all_result_rows, key)
        available_categories = {category for category, _count in counts}
        self._selected_category = (
            preserved_category if preserved_category in available_categories else None
        )
        self._configuring_categories = True
        try:
            self._category_tree.delete(*self._category_tree.get_children())
            self._category_values.clear()
            all_item = self._category_tree.insert(
                "",
                "end",
                text="全部",
                values=(len(self._all_result_rows),),
            )
            self._category_values[all_item] = None
            selected_item = all_item
            for category, count in counts:
                item_id = self._category_tree.insert(
                    "",
                    "end",
                    text=self._category_display_name(category),
                    values=(count,),
                )
                self._category_values[item_id] = category
                if category == self._selected_category:
                    selected_item = item_id
            self._category_tree.selection_set(selected_item)
            self._category_tree.focus(selected_item)
            self._category_tree.see(selected_item)
        finally:
            self._configuring_categories = False
        self._draw_current_rows()

    def _category_display_name(self, category: str) -> str:
        if self._category_mode == "search":
            return {
                "record": "Records",
                "entity": "Entities",
            }.get(category, category)
        return category

    def _on_category_selected(self, _event: tk.Event[tk.Misc]) -> None:
        if self._configuring_categories:
            return
        selection = self._category_tree.selection()
        if not selection:
            return
        if selection[0] not in self._category_values:
            return
        self._selected_category = self._category_values[selection[0]]
        self._draw_current_rows()

    def _draw_current_rows(self) -> None:
        rows = filter_by_category(
            self._all_result_rows,
            self._category_key,
            self._selected_category,
        )
        if self._category_mode == "entities":
            self._draw_entities(rows)
        elif self._category_mode == "candidates":
            self._draw_candidates(rows)
        elif self._category_mode == "search":
            self._draw_search(rows)
        else:
            self._draw_records(rows)
        self._update_result_heading(len(rows))

    def _update_result_heading(self, visible_count: int) -> None:
        total_count = len(self._all_result_rows)
        if self._selected_category is None:
            self._result_heading_var.set(self._base_result_heading)
            self._result_count_var.set(f"{visible_count} 筆 · 全部 · API 單頁最多 100 筆")
            return
        category = self._category_display_name(self._selected_category)
        self._result_heading_var.set(f"{self._base_result_heading} · {category}")
        self._result_count_var.set(f"{visible_count} / {total_count} 筆")

    def _draw_records(self, rows: list[JsonObject]) -> None:
        self._configure_result_columns((("title", "資料標題", 300, "w"),))
        self._clear_results()
        for row in rows:
            record_id = str(row.get("id") or "")
            item_id = self._result_tree.insert(
                "",
                "end",
                values=(compact_text(row.get("title")),),
            )
            self._row_targets[item_id] = ("record", record_id)

    def _draw_entities(self, rows: list[JsonObject]) -> None:
        self._configure_result_columns((("name", "Entity 名稱", 300, "w"),))
        self._clear_results()
        for row in rows:
            entity_id = str(row.get("id") or "")
            item_id = self._result_tree.insert(
                "",
                "end",
                values=(compact_text(row.get("name")),),
            )
            self._row_targets[item_id] = ("entity", entity_id)

    def _draw_search(self, rows: list[JsonObject]) -> None:
        self._configure_result_columns((("title", "搜尋結果", 300, "w"),))
        self._clear_results()
        for row in rows:
            target_id = str(row.get("id") or "")
            result_type = str(row.get("result_type") or "")
            item_id = self._result_tree.insert(
                "",
                "end",
                values=(compact_text(row.get("title")),),
            )
            self._row_targets[item_id] = (result_type, target_id)

    def _draw_candidates(self, rows: list[JsonObject]) -> None:
        self._configure_result_columns((("summary", "候選變更", 300, "w"),))
        self._clear_results()
        for row in rows:
            candidate_id = str(row.get("id") or "")
            item_id = self._result_tree.insert(
                "",
                "end",
                values=(compact_text(candidate_display_title(row)),),
            )
            self._row_targets[item_id] = ("candidate", candidate_id)

    def _on_result_selected(self, _event: tk.Event[tk.Misc]) -> None:
        self._open_selected()

    def _open_selected(self) -> None:
        selection = self._result_tree.selection()
        if not selection:
            self._status_var.set("請先選取中間清單的一筆資料")
            return
        target = self._row_targets.get(selection[0])
        if target is None:
            return
        target_type, target_id = target
        self._detail_request_serial += 1
        request_serial = self._detail_request_serial
        include_deleted = self._include_archived_var.get()
        if target_type == "record":
            self._submit(
                "讀取 Record 詳細內容",
                lambda: self._client.get_record(
                    target_id,
                    include_deleted=include_deleted,
                ),
                lambda record: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    record,
                ),
            )
        elif target_type == "entity":
            self._submit(
                "讀取 Entity 詳細內容",
                lambda: self._client.get_entity(
                    target_id,
                    include_deleted=include_deleted,
                ),
                lambda entity: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    entity,
                ),
            )
        elif target_type == "candidate":
            self._submit(
                "讀取 Candidate 詳細內容",
                lambda: self._client.get_candidate(target_id),
                lambda candidate: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    candidate,
                ),
            )

    def _render_detail_if_current(
        self,
        request_serial: int,
        target_type: str,
        target_id: str,
        detail: JsonObject,
    ) -> None:
        if request_serial != self._detail_request_serial:
            return
        if str(detail.get("id") or "") != target_id:
            return
        if target_type == "record":
            self._render_record_detail(detail)
        elif target_type == "entity":
            self._render_entity_detail(detail)
        elif target_type == "candidate":
            self._render_candidate_detail(detail)

    def _render_record_detail(self, record: JsonObject) -> None:
        record_id = str(record.get("id") or "")
        self._selected_record_id = record_id
        self._selected_detail_type = "record"
        self._selected_detail = record
        self._prepared_review = None
        self._detail_title_var.set(str(record.get("title") or "Untitled Record"))
        self._detail_meta_var.set(
            f"record:{display_identifier(record_id)} · {record.get('domain', '—')} · "
            f"v{record.get('version', '—')}"
        )
        self._set_text(self._summary_text, format_summary(record_summary_lines(record)))
        self._set_text(self._content_text, str(record.get("body_markdown") or "（沒有內容）"))
        self._set_text(self._payload_text, pretty_json(record.get("payload") or {}))
        self._set_text(self._raw_text, pretty_json(record))
        self._clear_links()
        self._populate_revisions(record)
        self._detail_notebook.select(0)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

        def load_extras() -> tuple[list[JsonObject], list[JsonObject]]:
            outbound = self._client.list_record_links(record_id, direction="outbound")
            inbound = self._client.list_record_links(record_id, direction="inbound")
            return outbound, inbound

        self._submit(
            "讀取 Record Links",
            load_extras,
            lambda links: self._render_links_if_current(record_id, links),
        )

    def _render_entity_detail(self, entity: JsonObject) -> None:
        self._selected_record_id = None
        entity_id = str(entity.get("id") or "")
        self._selected_detail_type = "entity"
        self._selected_detail = entity
        self._prepared_review = None
        self._detail_title_var.set(str(entity.get("name") or "Unnamed Entity"))
        self._detail_meta_var.set(
            f"entity:{display_identifier(entity_id)} · {entity.get('entity_type', '—')} · "
            f"v{entity.get('version', '—')}"
        )
        self._set_text(self._summary_text, format_summary(entity_summary_lines(entity)))
        self._set_text(self._content_text, str(entity.get("description") or "（沒有描述）"))
        self._set_text(self._payload_text, pretty_json(entity.get("payload") or {}))
        self._set_text(self._raw_text, pretty_json(entity))
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "Entity revision API 尚未提供。")
        self._detail_notebook.select(0)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _render_candidate_detail(self, candidate: JsonObject) -> None:
        self._selected_record_id = None
        candidate_id = str(candidate.get("id") or "")
        existing_prepared = self._prepared_review
        if (
            existing_prepared is not None
            and existing_prepared.get("candidate_id") == candidate_id
            and existing_prepared.get("review_digest") == candidate.get("review_digest")
            and candidate.get("status") == "pending"
        ):
            self._prepared_review = existing_prepared
        else:
            self._prepared_review = None
        self._selected_detail_type = "candidate"
        self._selected_detail = candidate
        self._detail_title_var.set(candidate_display_title(candidate))
        self._detail_meta_var.set(
            f"candidate:{display_identifier(candidate_id)} · "
            f"{candidate.get('status', '—')} · {candidate.get('candidate_kind', 'single')}"
        )
        self._set_text(
            self._summary_text,
            format_summary(
                [
                    ("Candidate ID", candidate_id),
                    ("狀態", str(candidate.get("status") or "—")),
                    ("類型", str(candidate.get("candidate_kind") or "single")),
                    ("操作", str(candidate.get("operation") or "change_set")),
                    ("目標", str(candidate.get("target_type") or "records")),
                    ("Target ID", str(candidate.get("target_id") or "—")),
                    ("Base version", str(candidate.get("base_version") or "—")),
                    ("來源", str(candidate.get("source_type") or "—")),
                    ("Review digest", str(candidate.get("review_digest") or "—")),
                    ("到期時間", str(candidate.get("expires_at") or "—")),
                    (
                        "Risk flags",
                        ", ".join(str(flag) for flag in candidate.get("risk_flags", [])) or "—",
                    ),
                ]
            ),
        )
        proposed = candidate.get("proposed_content")
        if candidate.get("candidate_kind") == "change_set":
            proposed = candidate.get("operations")
        self._set_text(self._content_text, pretty_json(proposed or {}))
        self._set_text(
            self._payload_text,
            pretty_json(candidate.get("validation_result") or {}),
        )
        self._set_text(self._raw_text, pretty_json(candidate))
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(
            self._revision_text,
            "Candidate 不會改寫歷史 Revision；核准後正式資料會建立新的 revision/audit。",
        )
        self._detail_notebook.select(0)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _reset_detail_view(self) -> None:
        self._selected_record_id = None
        self._selected_detail_type = None
        self._selected_detail = None
        self._prepared_review = None
        self._detail_title_var.set("選取一筆資料")
        self._detail_meta_var.set("從中間清單選取資料即可查看完整內容")
        self._set_text(self._summary_text, "")
        self._set_text(self._content_text, "")
        self._set_text(self._payload_text, "")
        self._set_text(self._raw_text, "")
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "")
        self._refresh_detail_actions()

    def _refresh_detail_actions(self) -> None:
        buttons = (
            self._new_button,
            self._edit_button,
            self._archive_button,
            self._prepare_button,
            self._approve_button,
            self._reject_button,
        )
        for button in buttons:
            button.pack_forget()

        if self._current_view in {"records", "entities"}:
            self._new_button.configure(
                text="新增 Record" if self._current_view == "records" else "新增 Entity"
            )
            self._new_button.pack(side="left")

        detail = self._selected_detail
        if self._selected_detail_type in {"record", "entity"} and detail is not None:
            if not detail.get("deleted_at"):
                self._edit_button.pack(side="left", padx=(6, 0))
                self._archive_button.pack(side="left", padx=(6, 0))
            return

        if self._selected_detail_type != "candidate" or detail is None:
            return
        if detail.get("status") != "pending":
            return
        self._prepare_button.pack(side="left")
        if self._prepared_review is not None:
            self._approve_button.pack(side="left", padx=(6, 0))
            self._reject_button.pack(side="left", padx=(6, 0))

    def _create_current(self) -> None:
        if self._current_view == "records":
            document = JsonDocumentDialog.show(
                self._root,
                title="新增 Record",
                helper=(
                    "填寫完整 Record create contract。kind、domain 與 source_type 建立後"
                    "不提供直接改寫；payload 可保存 schema-specific 欄位。"
                ),
                document=record_create_document(),
            )
            if document is not None:
                record_document = document
                self._submit(
                    "新增 Record 並讀回驗證",
                    lambda: self._client.create_record(record_document),
                    self._record_write_completed,
                )
        elif self._current_view == "entities":
            document = JsonDocumentDialog.show(
                self._root,
                title="新增 Entity",
                helper=(
                    "填寫完整 Entity create contract。entity_type 建立後維持身份穩定；"
                    "需要更換類型時請建立新 Entity 並封存舊資料。"
                ),
                document=entity_create_document(),
            )
            if document is not None:
                entity_document = document
                self._submit(
                    "新增 Entity 並讀回驗證",
                    lambda: self._client.create_entity(entity_document),
                    self._entity_write_completed,
                )

    def _edit_selected(self) -> None:
        detail = self._selected_detail
        detail_type = self._selected_detail_type
        if detail is None or detail_type not in {"record", "entity"}:
            self._status_var.set("請先選取要編輯的 Record 或 Entity")
            return
        target_id = str(detail.get("id") or "")
        current_version = detail.get("version")
        if not target_id or not isinstance(current_version, int):
            self._show_error("目前資料缺少可安全更新的 id/version。")
            return

        if detail_type == "record":
            document = JsonDocumentDialog.show(
                self._root,
                title=f"編輯 Record · {compact_text(detail.get('title'), limit=42)}",
                helper=(
                    "這裡只顯示 backend 允許更新的欄位。儲存時會強制使用目前版本，"
                    "若其他 client 已先更新，backend 會回傳 version conflict。"
                ),
                document=record_update_document(detail),
            )
            if document is None:
                return
            document["expected_version"] = current_version
            record_document = document
            self._submit(
                "更新 Record 並讀回驗證",
                lambda: self._client.update_record(target_id, record_document),
                self._record_write_completed,
            )
            return

        document = JsonDocumentDialog.show(
            self._root,
            title=f"編輯 Entity · {compact_text(detail.get('name'), limit=42)}",
            helper=(
                "這裡只顯示 backend 允許更新的欄位。儲存時會強制使用目前版本，"
                "若其他 client 已先更新，backend 會回傳 version conflict。"
            ),
            document=entity_update_document(detail),
        )
        if document is None:
            return
        document["expected_version"] = current_version
        entity_document = document
        self._submit(
            "更新 Entity 並讀回驗證",
            lambda: self._client.update_entity(target_id, entity_document),
            self._entity_write_completed,
        )

    def _archive_selected(self) -> None:
        detail = self._selected_detail
        detail_type = self._selected_detail_type
        if detail is None or detail_type not in {"record", "entity"}:
            self._status_var.set("請先選取要封存的 Record 或 Entity")
            return
        target_id = str(detail.get("id") or "")
        version = detail.get("version")
        title = detail.get("title") if detail_type == "record" else detail.get("name")
        if not target_id or not isinstance(version, int):
            self._show_error("目前資料缺少可安全封存的 id/version。")
            return
        confirmed = messagebox.askyesno(
            "確認刪除",
            (
                f"確定要刪除「{compact_text(title, limit=80)}」？\n\n"
                "這會將資料移至封存，一般清單不再顯示；不會永久抹除，"
                "歷史 Revision 與 Audit 仍會保留。"
            ),
            parent=self._root,
        )
        if not confirmed:
            return
        reason = "由本機 Memory Core Control Center 明確刪除（soft archive）"
        if detail_type == "record":
            self._submit(
                "封存 Record 並讀回驗證",
                lambda: self._client.archive_record(
                    target_id,
                    expected_version=version,
                    reason=reason,
                ),
                self._record_write_completed,
            )
        else:
            self._submit(
                "封存 Entity 並讀回驗證",
                lambda: self._client.archive_entity(
                    target_id,
                    expected_version=version,
                    reason=reason,
                ),
                self._entity_write_completed,
            )

    def _record_write_completed(self, record: JsonObject) -> None:
        self._render_record_detail(record)
        self._reload_after_write()

    def _entity_write_completed(self, entity: JsonObject) -> None:
        self._render_entity_detail(entity)
        self._reload_after_write()

    def _reload_after_write(self) -> None:
        self._reload_current_view()
        self._submit("更新控制中心概況", self._load_status, self._apply_status)

    def _prepare_candidate_review(self) -> None:
        candidate = self._selected_detail
        if self._selected_detail_type != "candidate" or candidate is None:
            self._status_var.set("請先選取 Candidate")
            return
        if candidate.get("status") != "pending":
            self._show_error("只有 pending Candidate 可以準備審核。")
            return
        candidate_id = str(candidate.get("id") or "")
        review_digest = str(candidate.get("review_digest") or "")
        if not candidate_id or not review_digest:
            self._show_error("Candidate 缺少 review digest，不能安全審核。")
            return
        self._submit(
            "準備 Candidate 審核",
            lambda: self._client.prepare_candidate_review(
                candidate_id,
                expected_review_digest=review_digest,
            ),
            self._candidate_review_prepared,
        )

    def _candidate_review_prepared(self, prepared: JsonObject) -> None:
        candidate = prepared.get("candidate")
        challenge = prepared.get("approval_challenge")
        expires_at = prepared.get("challenge_expires_at")
        if not isinstance(candidate, dict) or not isinstance(challenge, str):
            self._show_error("後端沒有回傳有效的 Candidate review challenge。")
            return
        candidate_id = str(candidate.get("id") or "")
        review_digest = str(candidate.get("review_digest") or "")
        self._prepared_review = {
            "candidate_id": candidate_id,
            "review_digest": review_digest,
            "approval_challenge": challenge,
            "challenge_expires_at": expires_at,
        }
        self._render_candidate_detail(candidate)
        self._status_var.set(f"Candidate 已準備審核；challenge 到期時間：{expires_at}")

    def _approve_candidate(self) -> None:
        context = self._prepared_candidate_context()
        if context is None:
            return
        candidate, prepared = context
        confirmed = messagebox.askyesno(
            "核准 Candidate",
            (
                f"確定要核准「{compact_text(candidate.get('summary'), limit=80)}」？\n\n"
                "這會將已顯示且 digest 相符的內容正式寫入 Memory Core，"
                "並建立 Revision 與 Audit。"
            ),
            parent=self._root,
        )
        if not confirmed:
            return
        candidate_id = str(candidate.get("id"))
        self._submit(
            "核准 Candidate 並驗證正式結果",
            lambda: self._client.approve_candidate(
                candidate_id,
                expected_review_digest=str(prepared["review_digest"]),
                approval_challenge=str(prepared["approval_challenge"]),
                idempotency_key=f"control-center-approve-{uuid.uuid4().hex}",
                review_note="由本機 Memory Core Control Center 完整審閱後核准",
            ),
            self._candidate_resolution_completed,
        )

    def _reject_candidate(self) -> None:
        context = self._prepared_candidate_context()
        if context is None:
            return
        candidate, prepared = context
        reason = simpledialog.askstring(
            "拒絕 Candidate",
            "請輸入拒絕原因：",
            parent=self._root,
        )
        if reason is None:
            return
        reason = reason.strip()
        if not reason:
            self._show_error("拒絕原因不可空白。")
            return
        confirmed = messagebox.askyesno(
            "確認拒絕",
            f"確定要拒絕這筆 Candidate？\n\n原因：{reason}",
            parent=self._root,
        )
        if not confirmed:
            return
        candidate_id = str(candidate.get("id"))
        self._submit(
            "拒絕 Candidate",
            lambda: self._client.reject_candidate(
                candidate_id,
                reason=reason,
                expected_review_digest=str(prepared["review_digest"]),
                approval_challenge=str(prepared["approval_challenge"]),
                idempotency_key=f"control-center-reject-{uuid.uuid4().hex}",
            ),
            self._candidate_resolution_completed,
        )

    def _prepared_candidate_context(self) -> tuple[JsonObject, JsonObject] | None:
        candidate = self._selected_detail
        prepared = self._prepared_review
        if (
            self._selected_detail_type != "candidate"
            or candidate is None
            or prepared is None
            or prepared.get("candidate_id") != candidate.get("id")
            or prepared.get("review_digest") != candidate.get("review_digest")
        ):
            self._show_error("請先對目前顯示的 Candidate 執行「準備審核」。")
            return None
        return candidate, prepared

    def _candidate_resolution_completed(self, candidate: JsonObject) -> None:
        self._prepared_review = None
        self._render_candidate_detail(candidate)
        self._reload_after_write()

    def _export_json(self) -> None:
        confirmed = messagebox.askyesno(
            "建立 JSON 匯出",
            "匯出檔包含私人記憶資料，會寫入本機 ignored data/exports。確定繼續？",
            parent=self._root,
        )
        if confirmed:
            self._submit(
                "建立 JSON 匯出",
                self._client.export_json,
                self._render_operation_result,
            )

    def _backup_sqlite(self) -> None:
        confirmed = messagebox.askyesno(
            "建立 SQLite 備份",
            (
                "備份包含 credential digest 與所有私人資料，會寫入本機 ignored "
                "data/backups。確定繼續？"
            ),
            parent=self._root,
        )
        if confirmed:
            self._submit(
                "建立 SQLite 備份並驗證",
                self._client.backup_sqlite,
                self._render_operation_result,
            )

    def _render_operation_result(self, result: JsonObject) -> None:
        self._selected_record_id = None
        self._selected_detail_type = "operation"
        self._selected_detail = result
        self._prepared_review = None
        self._detail_title_var.set(
            "JSON 匯出完成" if result.get("operation_type") == "json_export" else "SQLite 備份完成"
        )
        self._detail_meta_var.set(str(result.get("file_path") or "—"))
        self._set_text(
            self._summary_text,
            format_summary(
                [
                    ("Operation ID", str(result.get("id") or "—")),
                    ("類型", str(result.get("operation_type") or "—")),
                    ("檔案", str(result.get("file_path") or "—")),
                    ("SHA-256", str(result.get("content_hash") or "—")),
                    ("建立時間", str(result.get("created_at") or "—")),
                ]
            ),
        )
        self._set_text(self._content_text, pretty_json(result.get("counts") or {}))
        self._set_text(self._payload_text, pretty_json(result))
        self._set_text(self._raw_text, pretty_json(result))
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "管理作業不建立 Record revision。")
        self._detail_notebook.select(0)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _clear_links(self) -> None:
        self._link_tree.delete(*self._link_tree.get_children())

    def _render_links_if_current(
        self,
        record_id: str,
        links: tuple[list[JsonObject], list[JsonObject]],
    ) -> None:
        if self._selected_record_id != record_id:
            return
        self._clear_links()
        for direction, rows in (("outbound", links[0]), ("inbound", links[1])):
            for row in rows:
                target = row.get("target_ref") if direction == "outbound" else row.get("source_ref")
                self._link_tree.insert(
                    "",
                    "end",
                    values=(
                        "→" if direction == "outbound" else "←",
                        row.get("role", "—"),
                        target or "—",
                        row.get("target_revision_no") or "latest",
                        row.get("status", "—"),
                    ),
                )

    def _populate_revisions(self, record: JsonObject) -> None:
        self._revision_list.delete(0, "end")
        version = record.get("version")
        if not isinstance(version, int) or version < 1:
            self._set_text(self._revision_text, "沒有可讀取的 revision。")
            return
        for revision_no in range(version, 0, -1):
            suffix = "（目前）" if revision_no == version else ""
            self._revision_list.insert("end", f"v{revision_no} {suffix}".rstrip())
        self._set_text(
            self._revision_text,
            "請選取左側版本。歷史 snapshot 會在選取時從 API 讀取。",
        )

    def _open_revision(self, _event: tk.Event[tk.Misc]) -> None:
        selection = self._revision_list.curselection()  # type: ignore[no-untyped-call]
        record_id = self._selected_record_id
        if not selection or record_id is None:
            return
        label = self._revision_list.get(selection[0])
        try:
            revision_no = int(label.split()[0].removeprefix("v"))
        except (ValueError, IndexError):
            return
        self._submit(
            f"讀取 revision v{revision_no}",
            lambda: self._client.get_record_revision(record_id, revision_no),
            lambda revision: self._render_revision_if_current(
                record_id,
                revision_no,
                revision,
            ),
        )

    def _render_revision_if_current(
        self,
        record_id: str,
        revision_no: int,
        revision: JsonObject,
    ) -> None:
        if self._selected_record_id != record_id:
            return
        self._set_text(
            self._revision_text,
            f"Revision v{revision_no}\n\n{pretty_json(revision)}",
        )

    @staticmethod
    def _set_text(widget: tk.Text, value: str) -> None:
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", value)
        widget.configure(state="disabled")

    def _submit(
        self,
        label: str,
        work: Callable[[], T],
        on_success: Callable[[T], None],
    ) -> None:
        if self._closing:
            return
        self._active_requests += 1
        self._status_var.set(f"{label}…")
        future = self._executor.submit(work)

        def completed(done: Future[T]) -> None:
            if self._closing:
                return
            try:
                self._root.after(0, lambda: self._complete_request(label, done, on_success))
            except tk.TclError:
                return

        future.add_done_callback(completed)

    def _complete_request(
        self,
        label: str,
        future: Future[T],
        on_success: Callable[[T], None],
    ) -> None:
        self._active_requests = max(0, self._active_requests - 1)
        try:
            result = future.result()
        except ViewerApiError as exc:
            connection_state = "DISCONNECTED" if exc.code == "backend_unavailable" else "ERROR"
            self._connection_var.set(connection_state)
            self._show_error(exc.public_message())
            return
        except Exception:
            self._connection_var.set("ERROR")
            self._show_error("控制中心發生未預期錯誤。請查看啟動終端或重新開啟應用程式。")
            return
        on_success(result)
        if self._active_requests == 0:
            self._status_var.set(f"{label}完成")

    def _show_error(self, message: str) -> None:
        self._status_var.set(message)
        messagebox.showerror("Memory Core Control Center", message, parent=self._root)

    def _close(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._executor.shutdown(wait=False, cancel_futures=True)
        self._client.close()
        self._root.destroy()
