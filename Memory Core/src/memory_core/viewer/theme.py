from __future__ import annotations

import tkinter as tk
from tkinter import ttk

BG = "#F3F5F7"
SURFACE = "#FFFFFF"
SURFACE_MUTED = "#F7F9FB"
INK = "#172033"
MUTED = "#64748B"
NAVY = "#14213D"
NAVY_SOFT = "#223155"
ACCENT = "#0F766E"
ACCENT_HOVER = "#115E59"
ACCENT_SOFT = "#E1F2EF"
BORDER = "#D9E0E7"
WARNING = "#9A6700"
WARNING_SOFT = "#FFF3CD"
DANGER = "#B42318"
DANGER_SOFT = "#FDECEA"

FONT_UI = "Microsoft JhengHei UI"
FONT_FALLBACK = "Segoe UI"
FONT_MONO = "Consolas"


def configure_v2_styles(root: tk.Misc) -> None:
    style = ttk.Style(root)
    style.configure(
        "V2Primary.TButton",
        background=ACCENT,
        foreground="#FFFFFF",
        bordercolor=ACCENT,
        padding=(14, 7),
        font=(FONT_UI, 10, "bold"),
    )
    style.map(
        "V2Primary.TButton",
        background=[("active", ACCENT_HOVER), ("pressed", ACCENT_HOVER), ("disabled", "#94A3B8")],
        bordercolor=[("active", ACCENT_HOVER), ("pressed", ACCENT_HOVER)],
    )
    style.configure(
        "V2Secondary.TButton",
        background=SURFACE,
        foreground=INK,
        bordercolor=BORDER,
        padding=(11, 7),
        font=(FONT_UI, 9),
    )
    style.map(
        "V2Secondary.TButton",
        background=[("active", "#EAF0F3"), ("pressed", "#E1E8ED"), ("disabled", SURFACE_MUTED)],
        foreground=[("disabled", "#94A3B8")],
    )
    style.configure(
        "V2DangerSecondary.TButton",
        background=SURFACE,
        foreground=DANGER,
        bordercolor="#E8BBB7",
        padding=(11, 7),
        font=(FONT_UI, 9, "bold"),
    )
    style.map(
        "V2DangerSecondary.TButton",
        background=[("active", DANGER_SOFT), ("pressed", "#F8DAD7"), ("disabled", SURFACE_MUTED)],
        foreground=[("disabled", "#94A3B8")],
    )
    style.configure(
        "V2.TNotebook",
        background=SURFACE,
        borderwidth=0,
        tabmargins=(0, 0, 0, 0),
    )
    style.configure(
        "V2.TNotebook.Tab",
        background="#EAF0F3",
        foreground=MUTED,
        padding=(14, 8),
        borderwidth=0,
        font=(FONT_UI, 9),
    )
    style.map(
        "V2.TNotebook.Tab",
        background=[("selected", SURFACE)],
        foreground=[("selected", ACCENT)],
        expand=[("selected", (0, 0, 0, 2))],
    )
    style.configure(
        "V2.TCheckbutton",
        background=SURFACE,
        foreground=MUTED,
        font=(FONT_UI, 9),
    )
    style.configure(
        "V2.TEntry",
        padding=(9, 7),
        fieldbackground="#F9FBFC",
        bordercolor="#53637A",
        lightcolor="#53637A",
        darkcolor="#53637A",
    )
    style.map(
        "V2.TEntry",
        bordercolor=[("focus", "#78C7BA")],
        lightcolor=[("focus", "#78C7BA")],
        darkcolor=[("focus", "#78C7BA")],
    )
