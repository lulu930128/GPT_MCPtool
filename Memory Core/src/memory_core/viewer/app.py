from __future__ import annotations

import tkinter as tk
import uuid
from functools import partial
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from memory_core.viewer.client import JsonObject, ViewerApiClient
from memory_core.viewer.editor import JsonDocumentDialog, media_experience_batch_document
from memory_core.viewer.legacy_app import LegacyMemoryCoreViewer
from memory_core.viewer.presentation import (
    candidate_display_title,
    candidate_primary_fields,
    candidate_technical_fields,
    compact_text,
    entity_display_title,
    entity_primary_fields,
    entity_technical_fields,
    filter_by_category,
    format_datetime,
    pretty_json,
    record_display_title,
    record_primary_fields,
    record_technical_fields,
    result_list_summary,
)
from memory_core.viewer.theme import (
    ACCENT,
    ACCENT_SOFT,
    BG,
    BORDER,
    FONT_MONO,
    FONT_UI,
    INK,
    MUTED,
    NAVY,
    NAVY_SOFT,
    SURFACE,
    SURFACE_MUTED,
    WARNING,
    WARNING_SOFT,
    configure_v2_styles,
)
from memory_core.viewer.widgets import (
    BatchItemsPanel,
    CollectionMembersPanel,
    KeyValueSection,
    NavigationButton,
    ResultListItem,
    ResultListPanel,
)


class MemoryCoreViewer(LegacyMemoryCoreViewer):
    """Content-first v2 control center built on the verified legacy workflows."""

    def __init__(self, root: tk.Tk, client: ViewerApiClient) -> None:
        self._nav_buttons: dict[str, NavigationButton] = {}
        self._latest_health: JsonObject = {}
        self._latest_overview: JsonObject = {}
        self._latest_candidate_stats: JsonObject = {}
        self._collection_count = 0
        self._system_section = "overview"
        self._list_request_serial = 0
        super().__init__(root, client)

    def _configure_styles(self) -> None:
        super()._configure_styles()
        configure_v2_styles(self._root)

    def _build_layout(self) -> None:
        container = ttk.Frame(self._root, style="App.TFrame", padding=(14, 0, 14, 8))
        container.pack(fill="both", expand=True)
        self._build_v2_header(container)
        self._build_v2_workspace(container)
        self._build_status_bar(container)

    def _build_v2_header(self, parent: ttk.Frame) -> None:
        header = tk.Frame(parent, bg=NAVY, height=58)
        header.pack(fill="x", pady=(0, 9))
        header.pack_propagate(False)
        header.grid_columnconfigure(1, weight=1)

        tk.Label(
            header,
            text="Memory Core",
            bg=NAVY,
            fg="#FFFFFF",
            padx=18,
            font=(FONT_UI, 15, "bold"),
        ).grid(row=0, column=0, sticky="nsw")

        search_holder = tk.Frame(header, bg=NAVY)
        search_holder.grid(row=0, column=1, sticky="nsew", padx=(10, 12), pady=10)
        search_holder.grid_columnconfigure(0, weight=1)
        self._search_entry = ttk.Entry(
            search_holder,
            textvariable=self._search_var,
            style="V2.TEntry",
        )
        self._search_entry.grid(row=0, column=0, sticky="ew")
        self._search_entry.bind("<Return>", lambda _event: self._run_search())
        self._search_button = ttk.Button(
            search_holder,
            text="搜尋",
            style="V2Secondary.TButton",
            command=self._run_search,
        )
        self._search_button.grid(row=0, column=1, padx=(7, 0))

        self._new_button = ttk.Button(
            header,
            text="＋ 新增",
            style="V2Primary.TButton",
            command=self._create_current,
        )
        self._new_button.grid(row=0, column=2, padx=(0, 7), pady=10)
        ttk.Button(
            header,
            text="重新整理",
            style="V2Secondary.TButton",
            command=self.refresh_all,
        ).grid(row=0, column=3, padx=(0, 9), pady=10)
        self._connection_label = tk.Label(
            header,
            textvariable=self._connection_var,
            bg=NAVY_SOFT,
            fg="#BDEFE7",
            padx=11,
            pady=5,
            font=("Segoe UI", 9, "bold"),
        )
        self._connection_label.grid(row=0, column=4, padx=(0, 14))

    def _build_v2_workspace(self, parent: ttk.Frame) -> None:
        workspace = ttk.Panedwindow(parent, orient="horizontal")
        workspace.pack(fill="both", expand=True)

        navigation = tk.Frame(
            workspace,
            bg=SURFACE,
            width=205,
            highlightthickness=1,
            highlightbackground=BORDER,
        )
        result_area = tk.Frame(
            workspace,
            bg=SURFACE,
            width=370,
            highlightthickness=1,
            highlightbackground=BORDER,
        )
        detail_area = tk.Frame(
            workspace,
            bg=SURFACE,
            highlightthickness=1,
            highlightbackground=BORDER,
        )
        workspace.add(navigation, weight=0)
        workspace.add(result_area, weight=3)
        workspace.add(detail_area, weight=6)

        self._build_navigation(navigation)
        self._build_result_area(result_area)
        self._build_detail_area(detail_area)

    def _build_navigation(self, parent: tk.Frame) -> None:
        tk.Label(
            parent,
            text="瀏覽",
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            padx=13,
            pady=10,
            font=(FONT_UI, 9, "bold"),
        ).pack(fill="x")
        nav_items = (
            ("records", "記憶庫"),
            ("collections", "清單"),
            ("entities", "實體"),
            ("candidates", "待審核"),
            ("system", "系統資訊"),
        )
        for view, label in nav_items:
            button = NavigationButton(
                parent,
                label=label,
                command=partial(self._switch_view, view),
            )
            button.pack(fill="x", padx=7, pady=2)
            button.set_selected(view == "records")
            self._nav_buttons[view] = button

        ttk.Separator(parent, orient="horizontal").pack(fill="x", padx=11, pady=(11, 5))
        category_header = tk.Frame(parent, bg=SURFACE)
        category_header.pack(fill="x", padx=13, pady=(4, 6))
        tk.Label(
            category_header,
            textvariable=self._category_heading_var,
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=(FONT_UI, 10, "bold"),
        ).pack(fill="x")
        tk.Label(
            category_header,
            textvariable=self._category_helper_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 8),
        ).pack(fill="x", pady=(2, 0))

        category_tree_frame = tk.Frame(parent, bg=SURFACE)
        category_tree_frame.pack(fill="both", expand=True, padx=(8, 3), pady=(0, 6))
        self._category_tree = ttk.Treeview(
            category_tree_frame,
            columns=("count",),
            show="tree headings",
            selectmode="browse",
            style="Category.Treeview",
        )
        self._category_tree.heading("#0", text="分類")
        self._category_tree.heading("count", text="筆數")
        self._category_tree.column("#0", width=136, minwidth=90, anchor="w")
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

        self._archived_check = ttk.Checkbutton(
            parent,
            text="包含已封存",
            variable=self._include_archived_var,
            command=self._reload_current_view,
            style="V2.TCheckbutton",
        )
        self._archived_check.pack(anchor="w", padx=12, pady=(2, 9))

    def _build_result_area(self, parent: tk.Frame) -> None:
        heading = tk.Frame(parent, bg=SURFACE)
        heading.pack(fill="x", padx=13, pady=(12, 9))
        tk.Label(
            heading,
            textvariable=self._result_heading_var,
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=(FONT_UI, 13, "bold"),
        ).pack(fill="x")
        tk.Label(
            heading,
            textvariable=self._result_count_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 8),
        ).pack(fill="x", pady=(2, 0))
        self._result_list = ResultListPanel(parent, on_open=self._open_result_item)
        self._result_list.pack(fill="both", expand=True, padx=(10, 5), pady=(0, 8))

    def _build_detail_area(self, parent: tk.Frame) -> None:
        heading = tk.Frame(parent, bg=SURFACE)
        heading.pack(fill="x", padx=15, pady=(12, 8))
        heading.grid_columnconfigure(0, weight=1)
        title_area = tk.Frame(heading, bg=SURFACE)
        title_area.grid(row=0, column=0, sticky="ew")
        tk.Label(
            title_area,
            textvariable=self._detail_title_var,
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=(FONT_UI, 15, "bold"),
        ).pack(fill="x")
        self._detail_badges = tk.Frame(title_area, bg=SURFACE)
        self._detail_badges.pack(fill="x", pady=(5, 0))
        tk.Label(
            title_area,
            textvariable=self._detail_meta_var,
            bg=SURFACE,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 8),
        ).pack(fill="x", pady=(5, 0))

        self._detail_actions = ttk.Frame(heading, style="Surface.TFrame")
        self._detail_actions.grid(row=0, column=1, sticky="ne", padx=(12, 0))
        self._edit_button = ttk.Button(
            self._detail_actions,
            text="編輯",
            style="V2Secondary.TButton",
            command=self._edit_selected,
        )
        self._more_menu = tk.Menu(self._root, tearoff=False)
        self._more_menu.add_command(
            label="刪除（移至封存）",
            command=self._archive_selected,
        )
        self._more_button = ttk.Menubutton(
            self._detail_actions,
            text="更多",
            style="V2Secondary.TButton",
            menu=self._more_menu,
        )
        self._prepare_button = ttk.Button(
            self._detail_actions,
            text="準備審核",
            style="V2Secondary.TButton",
            command=self._prepare_candidate_review,
        )
        self._approve_button = ttk.Button(
            self._detail_actions,
            text="核准並寫入",
            style="V2Primary.TButton",
            command=self._approve_candidate,
        )
        self._reject_button = ttk.Button(
            self._detail_actions,
            text="拒絕",
            style="V2DangerSecondary.TButton",
            command=self._reject_candidate,
        )
        self._export_button = ttk.Button(
            self._detail_actions,
            text="JSON 匯出",
            style="V2Primary.TButton",
            command=self._export_json,
        )
        self._backup_button = ttk.Button(
            self._detail_actions,
            text="SQLite 備份",
            style="V2Secondary.TButton",
            command=self._backup_sqlite,
        )

        self._detail_notebook = ttk.Notebook(parent, style="V2.TNotebook")
        self._detail_notebook.pack(fill="both", expand=True, padx=13, pady=(0, 9))
        self._build_content_tab()
        self._build_related_tab()
        self._build_batch_items_tab()
        self._build_collection_members_tab()
        self._build_history_tab()
        self._build_technical_tab()
        self._refresh_detail_actions()

    def _build_content_tab(self) -> None:
        self._content_tab = tk.Frame(self._detail_notebook, bg=SURFACE)
        self._detail_notebook.add(self._content_tab, text="內容")
        self._content_tab.grid_columnconfigure(0, weight=1)
        self._content_tab.grid_rowconfigure(0, weight=1)
        self._content_text = self._create_readonly_text(
            self._content_tab,
            font=(FONT_UI, 10),
            background=SURFACE_MUTED,
        )
        self._content_text.grid(row=0, column=0, sticky="nsew", pady=(8, 6))
        primary_holder = tk.Frame(self._content_tab, bg=SURFACE)
        primary_holder.grid(row=1, column=0, sticky="ew", pady=(3, 8))
        tk.Label(
            primary_holder,
            text="關鍵資訊",
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=(FONT_UI, 10, "bold"),
        ).pack(fill="x", pady=(0, 3))
        self._primary_fields = KeyValueSection(primary_holder)
        self._primary_fields.pack(fill="x")

    def _build_related_tab(self) -> None:
        self._related_tab = tk.Frame(self._detail_notebook, bg=SURFACE)
        self._detail_notebook.add(self._related_tab, text="關聯")
        self._links_container = tk.Frame(self._related_tab, bg=SURFACE)
        self._links_container.pack(fill="both", expand=True, pady=8)
        self._link_tree = ttk.Treeview(
            self._links_container,
            columns=("direction", "role", "target", "revision", "status"),
            show="headings",
        )
        headings = (
            ("direction", "方向", 60),
            ("role", "角色", 110),
            ("target", "目標", 220),
            ("revision", "版本", 70),
            ("status", "狀態", 70),
        )
        for column, label, width in headings:
            self._link_tree.heading(column, text=label)
            self._link_tree.column(column, width=width, minwidth=55, anchor="w")
        scrollbar = ttk.Scrollbar(
            self._links_container,
            orient="vertical",
            command=self._link_tree.yview,
        )
        self._link_tree.configure(yscrollcommand=scrollbar.set)
        self._link_tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        self._validation_text = self._create_readonly_text(
            self._related_tab,
            font=(FONT_MONO, 9),
            background=SURFACE_MUTED,
        )

    def _build_batch_items_tab(self) -> None:
        self._batch_items_tab = tk.Frame(self._detail_notebook, bg=SURFACE)
        self._detail_notebook.add(self._batch_items_tab, text="批次項目")
        self._batch_items_panel = BatchItemsPanel(self._batch_items_tab)
        self._batch_items_panel.pack(fill="both", expand=True)

    def _build_collection_members_tab(self) -> None:
        self._collection_members_tab = tk.Frame(self._detail_notebook, bg=SURFACE)
        self._detail_notebook.add(self._collection_members_tab, text="清單項目")
        self._collection_members_panel = CollectionMembersPanel(
            self._collection_members_tab,
            on_open_record=lambda record_id: self._open_target("record", record_id),
        )
        self._collection_members_panel.pack(fill="both", expand=True)

    def _build_history_tab(self) -> None:
        self._revision_tab = ttk.Frame(
            self._detail_notebook,
            style="Surface.TFrame",
            padding=8,
        )
        self._detail_notebook.add(self._revision_tab, text="歷史版本")
        self._build_revision_tab()

    def _build_technical_tab(self) -> None:
        self._technical_tab = tk.Frame(self._detail_notebook, bg=SURFACE)
        self._detail_notebook.add(self._technical_tab, text="技術資訊")
        tk.Label(
            self._technical_tab,
            text="技術欄位",
            bg=SURFACE,
            fg=INK,
            anchor="w",
            font=(FONT_UI, 10, "bold"),
        ).pack(fill="x", pady=(9, 3))
        self._technical_fields = KeyValueSection(self._technical_tab)
        self._technical_fields.pack(fill="x", pady=(0, 7))
        technical_notebook = ttk.Notebook(self._technical_tab, style="V2.TNotebook")
        technical_notebook.pack(fill="both", expand=True)
        payload_tab = tk.Frame(technical_notebook, bg=SURFACE)
        raw_tab = tk.Frame(technical_notebook, bg=SURFACE)
        technical_notebook.add(payload_tab, text="結構化資料")
        technical_notebook.add(raw_tab, text="原始 JSON")
        self._payload_text = self._create_readonly_text(
            payload_tab,
            font=(FONT_MONO, 9),
            background="#F8FAFC",
        )
        self._payload_text.pack(fill="both", expand=True, pady=6)
        self._raw_text = self._create_readonly_text(
            raw_tab,
            font=(FONT_MONO, 9),
            background="#F8FAFC",
        )
        self._raw_text.pack(fill="both", expand=True, pady=6)

    def _create_readonly_text(
        self,
        parent: tk.Misc,
        *,
        font: tuple[str, int],
        background: str,
    ) -> tk.Text:
        text = ScrolledText(
            parent,
            wrap="word",
            relief="flat",
            bg=background,
            fg=INK,
            insertbackground=INK,
            padx=13,
            pady=11,
            spacing1=2,
            spacing3=4,
            font=font,
            state="disabled",
        )
        return text

    def _build_status_bar(self, parent: ttk.Frame) -> None:
        bar = tk.Frame(parent, bg=BG)
        bar.pack(fill="x", pady=(6, 0))
        tk.Label(
            bar,
            textvariable=self._status_var,
            bg=BG,
            fg=MUTED,
            anchor="w",
            font=(FONT_UI, 8),
        ).pack(side="left", fill="x", expand=True)
        tk.Label(
            bar,
            text="本機控制中心",
            bg=BG,
            fg=ACCENT,
            font=(FONT_UI, 8, "bold"),
        ).pack(side="right")

    def _apply_status(self, result: tuple[JsonObject, JsonObject, JsonObject]) -> None:
        self._latest_health, self._latest_overview, self._latest_candidate_stats = result
        super()._apply_status(result)
        healthy = (
            self._latest_health.get("status") == "ok"
            and self._latest_health.get("database") == "ok"
        )
        self._connection_label.configure(
            bg=ACCENT if healthy else "#7C2D12",
            fg="#FFFFFF",
        )
        records = self._latest_overview.get("records")
        entities = self._latest_overview.get("entities")
        record_count = records.get("active", 0) if isinstance(records, dict) else "—"
        entity_count = entities.get("active", 0) if isinstance(entities, dict) else "—"
        self._nav_buttons["records"].set_count(record_count)
        self._nav_buttons["collections"].set_count(self._collection_count)
        self._nav_buttons["entities"].set_count(entity_count)
        self._nav_buttons["candidates"].set_count(self._latest_candidate_stats.get("pending", 0))
        self._nav_buttons["system"].set_count("●" if healthy else "!")
        if self._current_view == "system" and self._selected_detail_type != "operation":
            self._render_system_detail(self._system_section)

    def _switch_view(self, view: str) -> None:
        if view not in {"records", "collections", "entities", "candidates", "system"}:
            return
        self._list_request_serial += 1
        self._detail_request_serial += 1
        self._current_view = view
        self._search_var.set("")
        for nav_view, button in self._nav_buttons.items():
            button.set_selected(nav_view == view)
        searchable = view in {"records", "entities"}
        self._search_entry.configure(state="normal" if searchable else "disabled")
        self._search_button.configure(state="normal" if searchable else "disabled")
        self._archived_check.configure(state="normal" if searchable else "disabled")
        self._new_button.configure(state="normal" if searchable else "disabled")
        self._reset_detail_view()
        if view == "system":
            self._render_system_rows()
            self._render_system_detail("overview")
            self._submit("更新系統資訊", self._load_status, self._apply_status)
            return
        self._reload_current_view()

    def _reload_current_view(self) -> None:
        if self._current_view == "system":
            self._render_system_rows()
            return
        if self._search_var.get().strip():
            self._run_search()
            return
        include_deleted = self._include_archived_var.get()
        view = self._current_view
        self._list_request_serial += 1
        request_serial = self._list_request_serial
        if view == "candidates":
            self._submit(
                "讀取待審核清單",
                self._client.list_candidates,
                lambda rows: self._render_list_if_current(
                    request_serial,
                    view,
                    rows,
                ),
            )
        elif view == "collections":
            self._submit(
                "讀取記憶清單集合",
                self._client.list_collections,
                lambda rows: self._render_list_if_current(
                    request_serial,
                    view,
                    rows,
                ),
            )
        elif view == "entities":
            self._submit(
                "讀取實體清單",
                lambda: self._client.list_entities(include_deleted=include_deleted),
                lambda rows: self._render_list_if_current(
                    request_serial,
                    view,
                    rows,
                ),
            )
        else:
            self._submit(
                "讀取記憶清單",
                lambda: self._client.list_records(include_deleted=include_deleted),
                lambda rows: self._render_list_if_current(
                    request_serial,
                    view,
                    rows,
                ),
            )

    def _render_list_if_current(
        self,
        request_serial: int,
        view: str,
        rows: list[JsonObject],
    ) -> None:
        if request_serial != self._list_request_serial or view != self._current_view:
            return
        if view == "candidates":
            self._render_candidates(rows)
        elif view == "collections":
            self._render_collections(rows)
        elif view == "entities":
            self._render_entities(rows)
        else:
            self._render_records(rows)

    def _run_search(self) -> None:
        query = self._search_var.get().strip()
        if not query:
            self._reload_current_view()
            return
        self._list_request_serial += 1
        request_serial = self._list_request_serial
        self._detail_request_serial += 1
        self._current_view = "search"
        for button in self._nav_buttons.values():
            button.set_selected(False)
        self._new_button.configure(state="disabled")
        self._archived_check.configure(state="disabled")
        self._reset_detail_view()
        self._submit(
            f"搜尋「{compact_text(query, limit=32)}」",
            lambda: self._client.search(query),
            lambda rows: self._render_search_if_current(
                request_serial,
                query,
                rows,
            ),
        )

    def _render_search_if_current(
        self,
        request_serial: int,
        query: str,
        rows: list[JsonObject],
    ) -> None:
        if request_serial != self._list_request_serial or self._current_view != "search":
            return
        if query != self._search_var.get().strip():
            return
        self._render_search(query, rows)

    def _render_records(self, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="records",
            key="domain",
            heading="記憶清單",
            category_heading="領域分類",
            category_helper="依 domain 瀏覽",
        )

    def _render_entities(self, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="entities",
            key="entity_type",
            heading="實體清單",
            category_heading="實體類型",
            category_helper="依 entity_type 瀏覽",
        )

    def _render_collections(self, rows: list[JsonObject]) -> None:
        self._collection_count = len(rows)
        self._nav_buttons["collections"].set_count(self._collection_count)
        self._set_category_rows(
            rows,
            mode="collections",
            key="domain",
            heading="清單集合",
            category_heading="領域分類",
            category_helper="選取清單後逐筆開啟記憶",
        )

    def _render_search(self, query: str, rows: list[JsonObject]) -> None:
        self._set_category_rows(
            rows,
            mode="search",
            key="result_type",
            heading=f"搜尋：{compact_text(query, limit=34)}",
            category_heading="結果類型",
            category_helper="記憶庫 / 實體",
        )

    def _render_candidates(self, rows: list[JsonObject]) -> None:
        previous_mode = self._category_mode
        self._set_category_rows(
            rows,
            mode="candidates",
            key="status",
            heading="待審核清單",
            category_heading="審核狀態",
            category_helper="pending / applied / rejected",
        )
        if previous_mode != "candidates":
            self._select_category_value("pending")

    def _select_category_value(self, value: str) -> None:
        target_item = next(
            (item_id for item_id, category in self._category_values.items() if category == value),
            None,
        )
        if target_item is None:
            return
        self._configuring_categories = True
        try:
            self._selected_category = value
            self._category_tree.selection_set(target_item)
            self._category_tree.focus(target_item)
            self._category_tree.see(target_item)
        finally:
            self._configuring_categories = False
        self._draw_current_rows()

    def _category_display_name(self, category: str) -> str:
        if self._category_mode == "search":
            return {"record": "記憶庫", "entity": "實體"}.get(category, category)
        return category

    def _on_category_selected(self, event: tk.Event[tk.Misc]) -> None:
        if self._configuring_categories:
            return
        self._detail_request_serial += 1
        super()._on_category_selected(event)
        self._reset_detail_view()

    def _update_result_heading(self, visible_count: int) -> None:
        total_count = len(self._all_result_rows)
        if self._selected_category is None:
            self._result_heading_var.set(self._base_result_heading)
            self._result_count_var.set(f"{visible_count} 筆 · 全部")
            return
        category = self._category_display_name(self._selected_category)
        self._result_heading_var.set(f"{self._base_result_heading} · {category}")
        self._result_count_var.set(f"{visible_count} / {total_count} 筆")

    def _clear_results(self) -> None:
        self._result_list.set_items(())

    def _draw_current_rows(self) -> None:
        rows = filter_by_category(
            self._all_result_rows,
            self._category_key,
            self._selected_category,
        )
        if self._category_mode == "collections":
            self._draw_collections(rows)
        elif self._category_mode == "entities":
            self._draw_entities(rows)
        elif self._category_mode == "candidates":
            self._draw_candidates(rows)
        elif self._category_mode == "search":
            self._draw_search(rows)
        else:
            self._draw_records(rows)
        self._update_result_heading(len(rows))

    def _draw_records(self, rows: list[JsonObject]) -> None:
        items = [
            ResultListItem(
                target_type="record",
                target_id=str(row.get("id") or ""),
                title=record_display_title(row),
                summary=result_list_summary(row, "record"),
                meta=self._list_meta(row.get("domain"), row.get("updated_at")),
            )
            for row in rows
            if row.get("id")
        ]
        self._result_list.set_items(items)

    def _draw_entities(self, rows: list[JsonObject]) -> None:
        items = [
            ResultListItem(
                target_type="entity",
                target_id=str(row.get("id") or ""),
                title=entity_display_title(row),
                summary=result_list_summary(row, "entity"),
                meta=self._list_meta(row.get("entity_type"), row.get("updated_at")),
            )
            for row in rows
            if row.get("id")
        ]
        self._result_list.set_items(items)

    def _draw_collections(self, rows: list[JsonObject]) -> None:
        items = [
            ResultListItem(
                target_type="collection",
                target_id=str(row.get("key") or ""),
                title=str(row.get("name") or row.get("key") or "未命名清單"),
                summary=compact_text(row.get("description"), limit=105),
                meta=self._list_meta(
                    f"{row.get('domain') or '未分類'} · {row.get('member_count', 0)} 筆",
                    row.get("updated_at"),
                ),
            )
            for row in rows
            if row.get("key")
        ]
        self._result_list.set_items(items)

    def _draw_search(self, rows: list[JsonObject]) -> None:
        items: list[ResultListItem] = []
        for row in rows:
            target_id = str(row.get("id") or "")
            result_type = str(row.get("result_type") or "")
            if not target_id or result_type not in {"record", "entity"}:
                continue
            title = (
                entity_display_title(row) if result_type == "entity" else record_display_title(row)
            )
            items.append(
                ResultListItem(
                    target_type=result_type,
                    target_id=target_id,
                    title=title,
                    summary=result_list_summary(row, result_type),
                    meta=self._list_meta(result_type, row.get("updated_at")),
                )
            )
        self._result_list.set_items(items)

    def _draw_candidates(self, rows: list[JsonObject]) -> None:
        items = [
            ResultListItem(
                target_type="candidate",
                target_id=str(row.get("id") or ""),
                title=candidate_display_title(row),
                summary=result_list_summary(row, "candidate"),
                meta=self._list_meta(row.get("candidate_kind"), row.get("created_at")),
            )
            for row in rows
            if row.get("id")
        ]
        self._result_list.set_items(items)

    @staticmethod
    def _list_meta(category: object, timestamp: object) -> str:
        category_text = str(category or "未分類")
        time_text = format_datetime(timestamp)
        return category_text if time_text == "—" else f"{category_text} · {time_text}"

    def _open_result_item(self, item: ResultListItem) -> None:
        if item.target_type == "system":
            self._render_system_detail(item.target_id)
            return
        self._open_target(item.target_type, item.target_id)

    def _open_selected(self) -> None:
        selected = self._result_list.selected_item
        if selected is None:
            self._status_var.set("請先選取中間清單的一筆資料")
            return
        self._open_result_item(selected)

    def _open_target(self, target_type: str, target_id: str) -> None:
        self._detail_request_serial += 1
        request_serial = self._detail_request_serial
        include_deleted = self._include_archived_var.get()
        if target_type == "record":
            self._submit(
                "讀取記憶詳細內容",
                lambda: self._client.get_record(target_id, include_deleted=include_deleted),
                lambda record: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    record,
                ),
            )
        elif target_type == "entity":
            self._submit(
                "讀取實體詳細內容",
                lambda: self._client.get_entity(target_id, include_deleted=include_deleted),
                lambda entity: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    entity,
                ),
            )
        elif target_type == "candidate":
            self._submit(
                "讀取待審核內容",
                lambda: self._load_candidate_detail(target_id),
                lambda candidate: self._render_detail_if_current(
                    request_serial,
                    target_type,
                    target_id,
                    candidate,
                ),
            )
        elif target_type == "collection":
            self._submit(
                "讀取清單項目",
                lambda: self._client.get_collection(target_id, limit=500),
                lambda collection: self._render_collection_if_current(
                    request_serial,
                    target_id,
                    collection,
                ),
            )

    def _render_collection_if_current(
        self,
        request_serial: int,
        collection_key: str,
        collection: JsonObject,
    ) -> None:
        if request_serial != self._detail_request_serial:
            return
        if str(collection.get("key") or "") != collection_key:
            return
        self._render_collection_detail(collection)

    def _load_candidate_detail(self, candidate_id: str) -> JsonObject:
        candidate = self._client.get_candidate(candidate_id)
        if candidate.get("candidate_kind") != "batch":
            return candidate
        batch = self._client.get_candidate_batch(candidate_id)
        return {**candidate, "_batch": batch}

    def _render_record_detail(self, record: JsonObject) -> None:
        record_id = str(record.get("id") or "")
        self._selected_record_id = record_id
        self._selected_detail_type = "record"
        self._selected_detail = record
        self._prepared_review = None
        self._detail_title_var.set(record_display_title(record))
        self._detail_meta_var.set(f"最近更新：{format_datetime(record.get('updated_at'))}")
        self._set_badges(
            (
                str(record.get("domain") or "未分類"),
                str(record.get("verification_status") or "未確認"),
                str(record.get("lifecycle_status") or "active"),
                f"重要度 {record.get('importance', '—')}",
            )
        )
        self._configure_detail_tabs("record")
        self._set_reading_content(
            summary=str(record.get("summary") or "（未提供摘要）"),
            body=str(record.get("body_markdown") or "（沒有正文內容）"),
            body_label="正文",
        )
        self._primary_fields.set_rows(record_primary_fields(record))
        self._technical_fields.set_rows(record_technical_fields(record))
        self._set_text(self._payload_text, pretty_json(record.get("payload") or {}))
        self._set_text(self._raw_text, pretty_json(record))
        self._clear_links()
        self._populate_revisions(record)
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

        def load_extras() -> tuple[list[JsonObject], list[JsonObject]]:
            outbound = self._client.list_record_links(record_id, direction="outbound")
            inbound = self._client.list_record_links(record_id, direction="inbound")
            return outbound, inbound

        self._submit(
            "讀取記憶關聯",
            load_extras,
            lambda links: self._render_links_if_current(record_id, links),
        )

    def _render_entity_detail(self, entity: JsonObject) -> None:
        self._selected_record_id = None
        self._selected_detail_type = "entity"
        self._selected_detail = entity
        self._prepared_review = None
        self._detail_title_var.set(entity_display_title(entity))
        self._detail_meta_var.set(f"最近更新：{format_datetime(entity.get('updated_at'))}")
        self._set_badges(
            (
                str(entity.get("entity_type") or "未分類"),
                "已封存" if entity.get("deleted_at") else "使用中",
            )
        )
        self._configure_detail_tabs("entity")
        self._set_reading_content(
            summary=str(entity.get("description") or "（未提供描述）"),
            body=str(entity.get("description") or "（沒有描述內容）"),
            body_label="描述",
        )
        self._primary_fields.set_rows(entity_primary_fields(entity))
        self._technical_fields.set_rows(entity_technical_fields(entity))
        self._set_text(self._payload_text, pretty_json(entity.get("payload") or {}))
        self._set_text(self._raw_text, pretty_json(entity))
        self._clear_links()
        self._set_text(self._validation_text, "Entity 關聯 API 尚未提供。")
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "Entity 歷史版本 API 尚未提供。")
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _render_collection_detail(self, collection: JsonObject) -> None:
        self._selected_record_id = None
        self._selected_detail_type = "collection"
        self._selected_detail = collection
        self._prepared_review = None
        self._detail_title_var.set(
            str(collection.get("name") or collection.get("key") or "未命名清單")
        )
        self._detail_meta_var.set(f"最近更新：{format_datetime(collection.get('updated_at'))}")
        self._set_badges(
            (
                str(collection.get("domain") or "未分類"),
                str(collection.get("lifecycle_status") or "active"),
                f"{collection.get('member_count', 0)} 筆",
                f"v{collection.get('version', '—')}",
            )
        )
        self._configure_detail_tabs("collection")
        self._set_reading_content(
            summary=str(collection.get("description") or "（未提供清單說明）"),
            body=(
                f"清單識別：{collection.get('key') or '—'}\n"
                f"領域：{collection.get('domain') or '未分類'}\n"
                f"項目數：{collection.get('member_count', 0)}"
            ),
            body_label="清單資訊",
        )
        self._primary_fields.set_rows(
            (
                ("清單識別", str(collection.get("key") or "—")),
                ("領域", str(collection.get("domain") or "未分類")),
                ("項目數", str(collection.get("member_count", 0))),
                ("版本", str(collection.get("version") or "—")),
            )
        )
        self._technical_fields.set_rows(())
        self._set_text(self._payload_text, pretty_json(collection.get("members") or []))
        self._set_text(self._raw_text, pretty_json(collection))
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "")
        self._collection_members_panel.set_collection(collection)
        self._batch_items_panel.set_batch(None)
        self._detail_notebook.select(self._collection_members_tab)  # type: ignore[no-untyped-call]
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
        self._detail_meta_var.set(f"建立時間：{format_datetime(candidate.get('created_at'))}")
        self._set_badges(
            (
                str(candidate.get("status") or "pending"),
                str(candidate.get("candidate_kind") or "single"),
                str(candidate.get("operation") or "change_set"),
            ),
            warning=candidate.get("status") == "pending",
        )
        self._configure_detail_tabs(
            "batch_candidate" if candidate.get("candidate_kind") == "batch" else "candidate"
        )
        proposed = candidate.get("proposed_content")
        if candidate.get("candidate_kind") == "change_set":
            proposed = candidate.get("operations")
        batch_detail = candidate.get("_batch")
        if isinstance(batch_detail, dict):
            execution_summary = batch_detail.get("execution_summary")
            if not isinstance(execution_summary, dict):
                execution_summary = {}
            proposed = (
                f"計畫狀態：{batch_detail.get('plan_state') or '—'}\n"
                f"執行狀態：{batch_detail.get('execution_state') or '—'}\n"
                f"總項目："
                f"{execution_summary.get('item_count', batch_detail.get('item_count', 0))}\n"
                f"已套用：{execution_summary.get('applied', 0)}\n"
                f"失敗：{execution_summary.get('failed', 0)}\n"
                f"待驗證：{execution_summary.get('unverified', 0)}\n"
                f"待處理：{execution_summary.get('pending', 0)}"
            )
        self._set_reading_content(
            summary=str(candidate.get("summary") or "等待人工審核的變更"),
            body=proposed if isinstance(proposed, str) else pretty_json(proposed or {}),
            body_label="批次摘要" if isinstance(batch_detail, dict) else "變更內容",
        )
        self._primary_fields.set_rows(candidate_primary_fields(candidate))
        self._technical_fields.set_rows(candidate_technical_fields(candidate))
        self._set_text(self._validation_text, pretty_json(candidate.get("validation_result") or {}))
        if isinstance(batch_detail, dict):
            self._set_text(
                self._validation_text,
                pretty_json(
                    {
                        "plan_state": batch_detail.get("plan_state"),
                        "review_state": batch_detail.get("review_state"),
                        "execution_state": batch_detail.get("execution_state"),
                        "current_revision_no": batch_detail.get("current_revision_no"),
                        "plan_hash": batch_detail.get("plan_hash"),
                        "items": [
                            {
                                "unit_key": item.get("unit_key"),
                                "decision": item.get("decision"),
                                "execution_state": item.get("execution_state"),
                                "error_code": item.get("error_code"),
                                "error_message": item.get("error_message"),
                                "execution_error_code": item.get("execution_error_code"),
                                "execution_error_message": item.get("execution_error_message"),
                                "retry_policy": item.get("retry_policy"),
                            }
                            for item in batch_detail.get("items", [])
                            if isinstance(item, dict)
                        ],
                    }
                ),
            )
        self._batch_items_panel.set_batch(batch_detail if isinstance(batch_detail, dict) else None)
        self._collection_members_panel.set_collection(None)
        self._set_text(
            self._payload_text,
            pretty_json(
                batch_detail.get("items", []) if isinstance(batch_detail, dict) else proposed or {}
            ),
        )
        self._set_text(self._raw_text, pretty_json(candidate))
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(
            self._revision_text,
            "候選資料不改寫歷史版本；核准後正式資料會建立新的 Revision 與 Audit。",
        )
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _configure_detail_tabs(self, mode: str) -> None:
        is_candidate = mode in {"candidate", "batch_candidate"}
        content_title = "變更內容" if is_candidate else "內容"
        related_title = "驗證結果" if is_candidate else "關聯"
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._content_tab,
            text=content_title,
            state="normal",
        )
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._related_tab,
            text=related_title,
            state="normal",
        )
        history_state = "normal" if mode == "record" else "hidden"
        related_state = "hidden" if mode == "system" else "normal"
        batch_state = "normal" if mode == "batch_candidate" else "hidden"
        collection_state = "normal" if mode == "collection" else "hidden"
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._related_tab,
            state=related_state,
        )
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._revision_tab,
            text="歷史版本",
            state=history_state,
        )
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._batch_items_tab,
            state=batch_state,
        )
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._collection_members_tab,
            state=collection_state,
        )
        self._detail_notebook.tab(  # type: ignore[no-untyped-call]
            self._technical_tab,
            text="技術資訊",
            state="normal",
        )
        if is_candidate:
            self._links_container.pack_forget()
            self._validation_text.pack(fill="both", expand=True, pady=8)
        else:
            self._validation_text.pack_forget()
            self._links_container.pack(fill="both", expand=True, pady=8)

    def _set_reading_content(self, *, summary: str, body: str, body_label: str) -> None:
        widget = self._content_text
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.tag_configure("section", foreground=ACCENT, font=(FONT_UI, 9, "bold"))
        widget.tag_configure("summary", foreground=INK, font=(FONT_UI, 11, "bold"), spacing3=14)
        widget.tag_configure("body", foreground=INK, font=(FONT_UI, 10), lmargin1=0, lmargin2=0)
        widget.insert("end", "摘要\n", "section")
        widget.insert("end", f"{summary.strip() or '（未提供摘要）'}\n\n", "summary")
        widget.insert("end", f"{body_label}\n", "section")
        widget.insert("end", body.strip() or "（沒有內容）", "body")
        widget.configure(state="disabled")

    def _set_badges(self, values: tuple[str, ...], *, warning: bool = False) -> None:
        for child in self._detail_badges.winfo_children():
            child.destroy()
        for index, value in enumerate(values):
            is_warning = warning and index == 0
            tk.Label(
                self._detail_badges,
                text=value,
                bg=WARNING_SOFT if is_warning else ACCENT_SOFT,
                fg=WARNING if is_warning else ACCENT,
                padx=7,
                pady=2,
                font=(FONT_UI, 8, "bold"),
            ).pack(side="left", padx=(0, 5))

    def _reset_detail_view(self) -> None:
        self._selected_record_id = None
        self._selected_detail_type = None
        self._selected_detail = None
        self._prepared_review = None
        self._detail_title_var.set("選取一筆資料")
        self._detail_meta_var.set("從中間清單選取內容，即可在這裡閱讀與操作")
        self._set_badges(())
        self._configure_detail_tabs("record")
        self._set_reading_content(
            summary="選取一筆記憶、實體或待審核項目。",
            body="詳細內容會顯示在這裡；底層欄位收在「技術資訊」。",
            body_label="使用方式",
        )
        self._primary_fields.set_rows(())
        self._technical_fields.set_rows(())
        self._set_text(self._payload_text, "")
        self._set_text(self._raw_text, "")
        self._set_text(self._validation_text, "")
        self._batch_items_panel.set_batch(None)
        self._collection_members_panel.set_collection(None)
        self._clear_links()
        self._revision_list.delete(0, "end")
        self._set_text(self._revision_text, "")
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _refresh_detail_actions(self) -> None:
        for button in (
            self._edit_button,
            self._more_button,
            self._prepare_button,
            self._approve_button,
            self._reject_button,
            self._export_button,
            self._backup_button,
        ):
            button.pack_forget()

        detail = self._selected_detail
        if self._selected_detail_type in {"record", "entity"} and detail is not None:
            if not detail.get("deleted_at"):
                self._edit_button.pack(side="left")
                self._more_button.pack(side="left", padx=(6, 0))
            return
        if self._selected_detail_type == "candidate" and detail is not None:
            if detail.get("status") != "pending":
                return
            batch_detail = detail.get("_batch")
            if (
                detail.get("candidate_kind") == "batch"
                and isinstance(batch_detail, dict)
                and batch_detail.get("review_state") == "pending"
            ):
                self._edit_button.configure(text="修訂批次")
                self._edit_button.pack(side="left")
            prepared = self._prepared_review is not None
            self._prepare_button.pack(side="left")
            self._approve_button.configure(state="normal" if prepared else "disabled")
            self._approve_button.pack(side="left", padx=(6, 0))
            self._reject_button.configure(state="normal" if prepared else "disabled")
            self._reject_button.pack(side="left", padx=(6, 0))
            return
        if self._selected_detail_type in {"system", "operation"}:
            self._export_button.pack(side="left")
            self._backup_button.pack(side="left", padx=(6, 0))

    def _create_current(self) -> None:
        if self._current_view == "records":
            use_batch = messagebox.askyesnocancel(
                "新增記憶",
                (
                    "要建立可逐筆審核的媒體紀錄批次嗎？\n\n"
                    "「是」：1～50 筆媒體紀錄，先建立 Batch 候選。\n"
                    "「否」：開啟進階單筆 Record 直接寫入。\n"
                    "「取消」：不進行操作。"
                ),
                parent=self._root,
            )
            if use_batch is None:
                return
            if not use_batch:
                super()._create_current()
                return
            document = media_experience_batch_document()
            document["idempotency_key"] = f"viewer-media-{uuid.uuid4()}"
            result = JsonDocumentDialog.show(
                self._root,
                title="新增媒體紀錄批次",
                helper=(
                    "items 中每個 object 都會形成一筆獨立記憶；可一次放入 1～50 筆。"
                    "儲存只會建立待審核 Batch，不會直接寫入正式記憶。"
                ),
                document=document,
            )
            if result is not None:
                batch_document = result
                self._submit(
                    "建立 Batch 並讀回驗證",
                    lambda: self._client.create_media_experience_batch(batch_document),
                    self._batch_write_completed,
                )
            return
        super()._create_current()

    def _edit_selected(self) -> None:
        detail = self._selected_detail
        batch_detail = detail.get("_batch") if isinstance(detail, dict) else None
        if (
            isinstance(detail, dict)
            and detail.get("candidate_kind") == "batch"
            and isinstance(batch_detail, dict)
        ):
            if batch_detail.get("review_state") != "pending":
                self._show_error("只有尚未準備審核的 Batch 可以修訂。")
                return
            items = batch_detail.get("items")
            document: JsonObject = {
                "profile_id": batch_detail.get("profile_id"),
                "profile_version": batch_detail.get("profile_version"),
                "summary": detail.get("summary"),
                "items": [
                    item.get("input_snapshot")
                    for item in items
                    if isinstance(item, dict) and isinstance(item.get("input_snapshot"), dict)
                ]
                if isinstance(items, list)
                else [],
                "expected_revision_no": batch_detail.get("current_revision_no"),
            }
            revised = JsonDocumentDialog.show(
                self._root,
                title="修訂媒體紀錄批次",
                helper=(
                    "可更正單筆內容，或在 resolution 設定明確 target / exclude。"
                    "修訂會建立新的 immutable Batch revision；舊版本不會覆寫。"
                ),
                document=document,
            )
            if revised is not None:
                candidate_id = str(detail.get("id") or "")
                revision_document = revised
                self._submit(
                    "修訂 Batch 並讀回驗證",
                    lambda: self._client.revise_media_experience_batch(
                        candidate_id,
                        revision_document,
                    ),
                    self._batch_write_completed,
                )
            return
        super()._edit_selected()

    def _batch_write_completed(self, batch: JsonObject) -> None:
        candidate = batch.get("candidate")
        if not isinstance(candidate, dict):
            self._show_error("Batch 回應缺少 candidate。")
            return
        merged = {**candidate, "_batch": batch}
        self._switch_view("candidates")
        self._render_candidate_detail(merged)
        self._status_var.set(
            f"Batch revision {batch.get('current_revision_no', '—')} 已建立並讀回驗證"
        )

    def _render_system_rows(self) -> None:
        self._category_heading_var.set("系統管理")
        self._category_helper_var.set("管理操作集中於此")
        self._category_tree.delete(*self._category_tree.get_children())
        self._category_values.clear()
        self._all_result_rows = []
        self._result_heading_var.set("系統資訊")
        self._result_count_var.set("狀態、索引與本機資料操作")
        self._result_list.set_items(
            (
                ResultListItem(
                    "system",
                    "overview",
                    "執行狀態",
                    "查看 API、資料庫與搜尋索引狀態",
                    "唯讀診斷",
                ),
                ResultListItem(
                    "system",
                    "operations",
                    "匯出與備份",
                    "建立 JSON 匯出或經驗證的 SQLite 備份",
                    "需要明確確認",
                ),
            )
        )

    def _render_system_detail(self, section: str) -> None:
        self._system_section = section
        self._selected_record_id = None
        self._selected_detail_type = "system"
        self._selected_detail = {}
        self._prepared_review = None
        operations = section == "operations"
        self._detail_title_var.set("匯出與備份" if operations else "系統執行狀態")
        self._detail_meta_var.set("所有管理操作仍由 loopback FastAPI 驗證並留下 Audit")
        healthy = (
            self._latest_health.get("status") == "ok"
            and self._latest_health.get("database") == "ok"
        )
        self._set_badges(("已連線" if healthy else "連線異常", "本機 API"))
        self._configure_detail_tabs("system")
        if operations:
            summary = "匯出與備份已從日常瀏覽流程移到系統資訊。"
            body = (
                "JSON 匯出包含私人記憶；SQLite 備份另包含 credential digest。"
                "兩項操作都會先要求確認，輸出只寫入 ignored data 目錄。"
            )
        else:
            summary = "目前控制中心只連接本機 loopback API。"
            body = "這裡集中顯示連線、資料庫、索引與可見資料數量，不占用日常閱讀空間。"
        self._set_reading_content(summary=summary, body=body, body_label="說明")
        records = self._latest_overview.get("records")
        entities = self._latest_overview.get("entities")
        index = self._latest_overview.get("index")
        record_text = pretty_json(records) if isinstance(records, dict) else "—"
        entity_text = pretty_json(entities) if isinstance(entities, dict) else "—"
        index_text = pretty_json(index) if isinstance(index, dict) else "—"
        self._primary_fields.set_rows(
            (
                ("API", "connected" if healthy else "degraded"),
                ("資料庫", str(self._latest_health.get("database") or "—")),
                ("記憶數量", record_text),
                ("實體數量", entity_text),
                (
                    "待審核",
                    str(self._latest_candidate_stats.get("pending", "—")),
                ),
                ("搜尋索引", index_text),
            )
        )
        self._technical_fields.set_rows(
            (
                ("API Base URL", self._client.base_url),
                ("Layout", "v2"),
                ("資料存取", "loopback FastAPI only"),
            )
        )
        system_payload = {
            "health": self._latest_health,
            "overview": self._latest_overview,
            "candidate_stats": self._latest_candidate_stats,
        }
        self._set_text(self._payload_text, pretty_json(system_payload))
        self._set_text(self._raw_text, pretty_json(system_payload))
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()

    def _render_operation_result(self, result: JsonObject) -> None:
        self._selected_record_id = None
        self._selected_detail_type = "operation"
        self._selected_detail = result
        self._prepared_review = None
        export = result.get("operation_type") == "json_export"
        self._detail_title_var.set("JSON 匯出完成" if export else "SQLite 備份完成")
        self._detail_meta_var.set("管理作業已完成；檔案路徑請視為私人資料")
        self._set_badges(("完成", "本機檔案"))
        self._configure_detail_tabs("system")
        self._set_reading_content(
            summary="管理作業已由 backend 執行並回傳驗證資訊。",
            body=str(result.get("file_path") or "—"),
            body_label="輸出位置",
        )
        self._primary_fields.set_rows(
            (
                ("類型", str(result.get("operation_type") or "—")),
                ("檔案", str(result.get("file_path") or "—")),
                ("SHA-256", str(result.get("content_hash") or "—")),
                ("建立時間", format_datetime(result.get("created_at"))),
            )
        )
        self._technical_fields.set_rows((("Operation ID", str(result.get("id") or "—")),))
        self._set_text(self._payload_text, pretty_json(result.get("counts") or {}))
        self._set_text(self._raw_text, pretty_json(result))
        self._detail_notebook.select(self._content_tab)  # type: ignore[no-untyped-call]
        self._refresh_detail_actions()
