from __future__ import annotations

from copy import deepcopy
import json
import os
import sys
import traceback
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _configure_stdio() -> None:
    """Keep MCP stdio traffic UTF-8 on Windows and other non-UTF-8 shells."""
    for stream_name, errors in (
        ("stdin", "replace"),
        ("stdout", "strict"),
        ("stderr", "backslashreplace"),
    ):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors=errors)
            except Exception:
                pass


_configure_stdio()


PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "omi-search-mcp"
SERVER_VERSION = "0.2.0"
API_BASE_URL = (
    os.environ.get("OMI_SEARCH_API_BASE_URL")
    or os.environ.get("OMI_API_BASE_URL")
    or "http://127.0.0.1:8400"
).rstrip("/")
AI_TRUST_TOKEN = (
    os.environ.get("OMI_SEARCH_AI_TRUST_TOKEN")
    or os.environ.get("OMI_MCP_AI_TRUST_TOKEN")
    or os.environ.get("OMI_AI_TRUST_TOKEN")
    or ""
).strip()
AI_TRUST_TOKEN_HEADER = "X-OMI-AI-Trust-Token"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


API_TIMEOUT_SECONDS = _env_int("OMI_SEARCH_API_TIMEOUT_SECONDS", 90)
DEFAULT_REFRESH_IF_MISSING = _env_bool("OMI_SEARCH_DEFAULT_REFRESH_IF_MISSING", False)
DEFAULT_TOOL_BUDGET = {
    "max_calls": 3,
    "max_external_fetches": 2,
    "max_total_seconds": 20,
}
DEFAULT_LIST_LIMIT = 20
DEFAULT_POINTS_TAIL_LIMIT = 8
LIVE_QUOTE_INTENT_TERMS = (
    "即時",
    "即時訊息",
    "即時報價",
    "盤中",
    "報價",
    "現價",
    "現在價格",
    "intraday",
    "live",
    "realtime",
    "real-time",
    "quote",
    "current price",
    "latest price",
    "route_hint",
    "live_surface",
    "compact_live",
)
ALLOWED_MODES = {"data_only", "brief", "full"}
TARGET_TYPES = [
    "auto",
    "market",
    "data_freshness",
    "tw_stock",
    "tw_watchlist",
    "tw_index",
    "tw_futures",
    "us_stock",
    "jp_stock",
    "jp_index",
    "kr_stock",
    "kr_index",
    "crypto_market",
    "crypto_asset",
    "resource_asset",
    "portfolio",
    "us_macro",
    "us_watchlist",
    "jp_watchlist",
    "kr_watchlist",
    "source_health",
    "capability_status",
]
CAPABILITY_IDS = [
    "broker_branch.summary",
    "chips.institutional",
    "chips.margin",
    "company.profile",
    "corporate.actions",
    "cross_market.overnight",
    "crypto.derivatives",
    "crypto.order_book",
    "daily.ohlcv",
    "data.freshness",
    "derivatives.positioning",
    "derivatives.structure",
    "diagnostics.capabilities",
    "diagnostics.data_freshness",
    "diagnostics.source_health",
    "fundamentals.financials",
    "fundamentals.revenue",
    "intraday.bars",
    "macro.observations",
    "macro.series",
    "market.breadth",
    "market.chips",
    "market.cross_market",
    "market.sample_ranking",
    "market.short_volume",
    "market.volume_state",
    "ownership.distribution",
    "portfolio.holdings",
    "portfolio.summary",
    "portfolio.valuation",
    "quote.snapshot",
    "resource.metadata",
    "source.health",
    "target.identity",
    "technical.structure",
    "watchlist.coverage",
    "watchlist.radar",
    "watchlist.ranking",
]

PAYLOAD_LEVEL_SCHEMA: dict[str, Any] = {
    "type": "string",
    "enum": ["summary", "compact", "standard", "full"],
    "default": "compact",
    "description": "Controls bounded OMI market-data density. Use summary for short answers, compact by default, and standard/full only when more detail is requested.",
}
INTRADAY_LIMIT_SCHEMA: dict[str, Any] = {
    "type": "integer",
    "minimum": 1,
    "maximum": 500,
    "description": "Maximum intraday points to request per series. The OMI backend still applies its own upper bounds.",
}
INCLUDE_INTRADAY_SCHEMA: dict[str, Any] = {
    "type": "boolean",
    "default": False,
    "description": "Request bounded intraday evidence when the OMI backend policy allows it.",
}
MARKET_DATA_PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Optional bounded market-data parameters forwarded to OMI readers, for example "
        "provider, providers, symbol, symbols, instrument_type, interval, timeframe, "
        "bars, daily_limit, include_intraday, payload_level, intraday_limit, or limit."
    ),
    "properties": {
        "include_intraday": INCLUDE_INTRADAY_SCHEMA,
        "payload_level": PAYLOAD_LEVEL_SCHEMA,
        "intraday_limit": INTRADAY_LIMIT_SCHEMA,
    },
    "additionalProperties": True,
}
CAPABILITY_SELECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "OMI v4 bounded data selection. Choose only the capabilities, fields, "
        "and row/point limits needed by the caller."
    ),
    "properties": {
        "include": {
            "type": "array",
            "items": {"type": "string", "enum": CAPABILITY_IDS},
            "uniqueItems": True,
        },
        "required": {
            "type": "array",
            "items": {"type": "string", "enum": CAPABILITY_IDS},
            "uniqueItems": True,
        },
        "optional": {
            "type": "array",
            "items": {"type": "string", "enum": CAPABILITY_IDS},
            "uniqueItems": True,
        },
        "exclude": {
            "type": "array",
            "items": {"type": "string", "enum": CAPABILITY_IDS},
            "uniqueItems": True,
        },
        "fields": {
            "type": "object",
            "additionalProperties": {
                "type": "array",
                "items": {"type": "string"},
                "uniqueItems": True,
            },
        },
        "limits": {
            "type": "object",
            "additionalProperties": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500,
            },
        },
        "max_response_bytes": {
            "type": "integer",
            "minimum": 4096,
            "maximum": 1048576,
        },
    },
    "additionalProperties": False,
}


SEARCH_TOOL: dict[str, Any] = {
    "name": "omi.search",
    "title": "OMI_search",
    "description": (
        "OMI_search: read the canonical OMI decision envelope through the existing OMI backend. "
        "This adapter does not read the OMI database directly. It forwards "
        "requests to POST /api/ai/ask with allow_llm=false and allow_write=false. "
        "Set refresh_if_missing=true to let a trusted OMI backend attempt bounded "
        "stale-first evidence refresh before returning data; inspect "
        "execution.refresh_reconciliation for what actually ran."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "contract_version": {
                "type": "string",
                "enum": ["omi.decision.v4"],
                "default": "omi.decision.v4",
            },
            "query": {
                "type": "string",
                "description": "User request or data search intent. Example: 2330 latest price, chips, and broker branch context.",
            },
            "target": {
                "type": "object",
                "description": "Optional OMI target. Prefer type/id, for example {type: 'tw_stock', id: '2330'}.",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": TARGET_TYPES,
                        "default": "auto",
                    },
                    "id": {"type": "string"},
                    "symbol": {"type": "string"},
                    "label": {"type": "string"},
                    "market": {"type": "string"},
                },
                "default": {"type": "auto"},
            },
            "stock_id": {
                "type": "string",
                "description": "Convenience alias for target={type:'tw_stock', id: stock_id}. Ignored when target is provided.",
            },
            "symbol": {
                "type": "string",
                "description": "Convenience alias for target={type:'us_stock', id: symbol}. Ignored when target or stock_id is provided.",
            },
            "mode": {
                "type": "string",
                "enum": ["data_only", "brief", "full"],
                "default": "data_only",
                "description": (
                    "Read-only backend mode. The adapter always returns the unchanged "
                    "v4 envelope; use selection to control evidence density."
                ),
            },
            "intents": {
                "type": "array",
                "maxItems": 8,
                "items": {"type": "string"},
            },
            "output": {
                "type": "string",
                "enum": ["evidence_only", "decision", "decision_with_evidence"],
            },
            "realtime_policy": {
                "type": "string",
                "enum": ["cache_only", "prefer_live", "require_live"],
                "default": "prefer_live",
            },
            "selection": CAPABILITY_SELECTION_SCHEMA,
            "continuation": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string"},
                    "plan_action_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 32,
                        "uniqueItems": True,
                    },
                    "selected_action_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 8,
                        "uniqueItems": True,
                    },
                },
                "additionalProperties": False,
            },
            "refresh_if_missing": {
                "type": "boolean",
                "default": False,
                "description": (
                    "Allow the trusted OMI backend to attempt bounded refresh for stale or "
                    "missing evidence. This does not promise that every fill action executes "
                    "in the same request; inspect execution.refresh_reconciliation."
                ),
            },
            "tool_budget": {
                "type": "object",
                "properties": {
                    "max_calls": {"type": "integer", "minimum": 0, "maximum": 12, "default": 3},
                    "max_external_fetches": {"type": "integer", "minimum": 0, "maximum": 8, "default": 2},
                    "max_total_seconds": {"type": "integer", "minimum": 1, "maximum": 90, "default": 20},
                },
            },
            "refresh_policy": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["stale_first", "off"], "default": "stale_first"},
                    "before_answer": {"type": "boolean", "default": True},
                    "fallback_to_cached": {"type": "boolean", "default": True},
                },
            },
            "strategy_profile": {
                "type": "string",
                "enum": [
                    "balanced",
                    "technical_swing",
                    "short_term_momentum",
                    "chip_flow",
                    "fundamentals_growth",
                    "dividend_value",
                ],
                "default": "short_term_momentum",
            },
            "analysis_horizon": {
                "type": "string",
                "enum": ["auto", "intraday", "short", "swing", "long"],
                "default": "auto",
            },
            "branch_days": {"type": "integer", "minimum": 1, "maximum": 120, "default": 5},
            "rank_by": {
                "type": "string",
                "enum": ["watchlist", "score", "change_pct", "volume"],
                "default": "score",
            },
            "sort_order": {"type": "string", "enum": ["asc", "desc"], "default": "desc"},
            "market_limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            "context_limit": {"type": "integer", "minimum": 20, "maximum": 500, "default": 100},
            "include_intraday": INCLUDE_INTRADAY_SCHEMA,
            "payload_level": PAYLOAD_LEVEL_SCHEMA,
            "intraday_limit": INTRADAY_LIMIT_SCHEMA,
            "include_children": {"type": "boolean", "default": True},
            "enabled_only": {"type": "boolean", "default": True},
            "market_data_params": MARKET_DATA_PARAMS_SCHEMA,
            "conversation_context": {
                "type": "object",
                "description": "Optional OMI conversation context, for example the previous OMI resolution for follow-up requests.",
            },
            "include_raw": {
                "type": "boolean",
                "default": False,
                "description": (
                    "Deprecated compatibility flag. OMI v4 is always forwarded unchanged; "
                    "use selection and max_response_bytes to control payload size."
                ),
            },
        },
        "required": ["query"],
    },
}

PUBLIC_QUESTION_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description": (
        "Canonical OMI question or read intent. Example: "
        "2330 latest price, chips, and broker branch context."
    ),
}

ASK_TOOL = deepcopy(SEARCH_TOOL)
ASK_TOOL.update(
    {
        "name": "omi.ask",
        "title": "Ask OMI",
        "description": (
            "Canonical read-only OMI decision entry point. Returns the unchanged "
            "omi.decision.v4 envelope through POST /api/ai/ask. This external adapter "
            "always sets allow_llm=false and allow_write=false; bounded refresh is "
            "available only when refresh_if_missing=true."
        ),
    }
)
ASK_TOOL["inputSchema"]["properties"]["question"] = deepcopy(PUBLIC_QUESTION_SCHEMA)
ASK_TOOL["inputSchema"]["properties"].pop("query", None)
ASK_TOOL["inputSchema"]["required"] = ["question"]

SHORTCUT_CONTROL_NAMES = (
    "selection",
    "realtime_policy",
    "refresh_if_missing",
    "tool_budget",
    "refresh_policy",
    "include_intraday",
    "payload_level",
    "intraday_limit",
    "market_data_params",
)


def _shortcut_input_schema(
    extra_properties: dict[str, Any],
    *,
    required: tuple[str, ...] = (),
) -> dict[str, Any]:
    properties = {"question": deepcopy(PUBLIC_QUESTION_SCHEMA)}
    search_properties = SEARCH_TOOL["inputSchema"]["properties"]
    for name in SHORTCUT_CONTROL_NAMES:
        properties[name] = deepcopy(search_properties[name])
    properties.update(deepcopy(extra_properties))
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = list(required)
    return schema


MARKET_OVERVIEW_TOOL: dict[str, Any] = {
    "name": "omi.read_market_overview",
    "title": "Read OMI Market Overview",
    "description": (
        "Read a bounded market overview through the canonical OMI v4 ask contract. "
        "This shortcut is data-only and never calls an LLM or writes reports/memory."
    ),
    "inputSchema": _shortcut_input_schema(
        {
            "market": {
                "type": "string",
                "default": "tw",
                "description": "Market identifier such as tw, us, jp, kr, crypto, or resource.",
            },
        }
    ),
}

STOCK_CONTEXT_TOOL: dict[str, Any] = {
    "name": "omi.read_stock_context",
    "title": "Read OMI Stock Context",
    "description": (
        "Read one Taiwan, US, Japan, or Korea stock evidence context through the "
        "canonical OMI v4 ask contract. This shortcut is data-only."
    ),
    "inputSchema": _shortcut_input_schema(
        {
            "market": {
                "type": "string",
                "enum": ["tw", "us", "jp", "kr"],
                "default": "tw",
            },
            "symbol": {
                "type": "string",
                "description": "Stock id or symbol, for example 2330, TSM, 7203, or 005930.",
            },
            "analysis_horizon": deepcopy(
                SEARCH_TOOL["inputSchema"]["properties"]["analysis_horizon"]
            ),
        },
        required=("symbol",),
    ),
}

DATA_FRESHNESS_TOOL: dict[str, Any] = {
    "name": "omi.read_data_freshness",
    "title": "Read OMI Data Freshness",
    "description": (
        "Read OMI freshness evidence through the canonical v4 contract without "
        "hiding stale, partial, missing, or provider-error states."
    ),
    "inputSchema": _shortcut_input_schema(
        {
            "market": {
                "type": "string",
                "description": "Optional market filter such as tw, us, jp, kr, or crypto.",
            },
        }
    ),
}

SOURCE_HEALTH_TOOL: dict[str, Any] = {
    "name": "omi.read_source_health",
    "title": "Read OMI Source Health",
    "description": (
        "Read bounded provider/source health through the canonical OMI v4 contract. "
        "Counts and stale/partial/error states remain visible."
    ),
    "inputSchema": _shortcut_input_schema(
        {
            "market": {"type": "string"},
            "provider": {"type": "string"},
            "resource": {"type": "string"},
            "target_id": {
                "type": "string",
                "description": "Optional source-health target filter.",
            },
            "status_filter": {
                "oneOf": [
                    {"type": "string"},
                    {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 16,
                        "uniqueItems": True,
                    },
                ]
            },
            "problems_only": {"type": "boolean", "default": False},
            "include_healthy": {"type": "boolean", "default": True},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
        }
    ),
}

CAPABILITY_STATUS_TOOL: dict[str, Any] = {
    "name": "omi.read_capability_status",
    "title": "Read OMI Capability Status",
    "description": (
        "Read bounded OMI capability availability/status through the canonical v4 "
        "contract. This is a read-only diagnostic shortcut."
    ),
    "inputSchema": _shortcut_input_schema(
        {
            "capability_id": {"type": "string"},
            "market": {"type": "string"},
            "status": {"type": "string"},
            "enabled_only": deepcopy(
                SEARCH_TOOL["inputSchema"]["properties"]["enabled_only"]
            ),
            "include_children": deepcopy(
                SEARCH_TOOL["inputSchema"]["properties"]["include_children"]
            ),
            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
        }
    ),
}

PUBLIC_TOOLS = [
    ASK_TOOL,
    MARKET_OVERVIEW_TOOL,
    STOCK_CONTEXT_TOOL,
    DATA_FRESHNESS_TOOL,
    SOURCE_HEALTH_TOOL,
    CAPABILITY_STATUS_TOOL,
]
TOOLS = PUBLIC_TOOLS
LEGACY_TOOL_ALIASES = {"omi.search": "omi.ask"}


def _json_default(value: Any) -> str:
    return str(value)


def _replace_surrogates(value: str) -> str:
    return value.encode("utf-8", errors="replace").decode("utf-8")


def _sanitize_json_value(value: Any) -> Any:
    if isinstance(value, str):
        return _replace_surrogates(value)
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        return {
            _sanitize_json_value(str(key)): _sanitize_json_value(item)
            for key, item in value.items()
        }
    return value


def _write(message: dict[str, Any]) -> None:
    text = json.dumps(
        _sanitize_json_value(message),
        ensure_ascii=False,
        default=_json_default,
    ) + "\n"
    buffer = getattr(sys.stdout, "buffer", None)
    if buffer is not None:
        buffer.write(text.encode("utf-8"))
        buffer.flush()
        return
    sys.stdout.write(text)
    sys.stdout.flush()


def _response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(
    request_id: Any,
    code: int,
    message: str,
    data: Any | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }
    if data is not None:
        payload["error"]["data"] = data
    return payload


def _tool_result(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    safe_value = _sanitize_json_value(value)
    text = safe_value if isinstance(safe_value, str) else json.dumps(safe_value, ensure_ascii=False, default=_json_default)
    result: dict[str, Any] = {
        "content": [{"type": "text", "text": text}],
        "structuredContent": (
            safe_value if isinstance(safe_value, dict) else {"result": safe_value}
        ),
        "isError": bool(is_error),
    }
    return result


def _safe_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _bool_arg(arguments: dict[str, Any], key: str, default: bool) -> bool:
    value = arguments.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _dict_arg(arguments: dict[str, Any], key: str) -> dict[str, Any]:
    value = arguments.get(key)
    return dict(value) if isinstance(value, dict) else {}


def _market_data_params_arg(arguments: dict[str, Any]) -> dict[str, Any]:
    params = _dict_arg(arguments, "market_data_params")

    if "include_intraday" in arguments and "include_intraday" not in params:
        params["include_intraday"] = _bool_arg(arguments, "include_intraday", False)

    if "payload_level" in arguments and "payload_level" not in params:
        level = str(arguments.get("payload_level") or "").strip().lower()
        if level in {"summary", "compact", "standard", "full"}:
            params["payload_level"] = level

    if "intraday_limit" in arguments and "intraday_limit" not in params:
        params["intraday_limit"] = _safe_int(
            arguments.get("intraday_limit"),
            default=80,
            minimum=1,
            maximum=500,
        )

    return params


def _require_query(arguments: dict[str, Any]) -> str:
    value = arguments.get("question", arguments.get("query"))
    text = str(value or "").strip()
    if not text:
        raise ValueError("Missing required argument: question")
    return text


def _target_arg(arguments: dict[str, Any]) -> dict[str, Any]:
    target = arguments.get("target")
    if isinstance(target, dict) and target:
        return target

    stock_id = str(arguments.get("stock_id") or "").strip()
    if stock_id:
        return {"type": "tw_stock", "id": stock_id}

    symbol = str(arguments.get("symbol") or "").strip()
    if symbol:
        return {"type": "us_stock", "id": symbol.upper()}

    return {"type": "auto"}


def _tool_budget_arg(arguments: dict[str, Any], *, refresh_if_missing: bool) -> dict[str, int]:
    raw = arguments.get("tool_budget")
    if not isinstance(raw, dict) or not raw:
        return dict(DEFAULT_TOOL_BUDGET) if refresh_if_missing else {}

    return {
        "max_calls": _safe_int(
            raw.get("max_calls"),
            DEFAULT_TOOL_BUDGET["max_calls"],
            minimum=0,
            maximum=12,
        ),
        "max_external_fetches": _safe_int(
            raw.get("max_external_fetches"),
            DEFAULT_TOOL_BUDGET["max_external_fetches"],
            minimum=0,
            maximum=8,
        ),
        "max_total_seconds": _safe_int(
            raw.get("max_total_seconds"),
            DEFAULT_TOOL_BUDGET["max_total_seconds"],
            minimum=1,
            maximum=90,
        ),
    }


def _has_live_quote_intent(query: str) -> bool:
    normalized = query.strip().lower()
    return any(term in normalized for term in LIVE_QUOTE_INTENT_TERMS)


def _backend_question(
    *,
    question: str,
    target: dict[str, Any],
    analysis_horizon: str,
    live_intent: bool,
) -> str:
    if target.get("type") != "us_stock" or analysis_horizon != "intraday" or not live_intent:
        return question

    normalized = question.lower()
    if "intraday" in normalized and "quote" in normalized:
        return question

    return f"{question} intraday live quote compact"


def _search_payload(arguments: dict[str, Any]) -> dict[str, Any]:
    mode = str(arguments.get("mode") or "data_only").strip()
    if mode not in ALLOWED_MODES:
        raise ValueError("mode must be one of: data_only, brief, full")

    question = _require_query(arguments)
    target = _target_arg(arguments)
    requested_horizon = str(arguments.get("analysis_horizon") or "auto").strip() or "auto"
    live_intent = _has_live_quote_intent(question)
    if target.get("type") == "us_stock" and requested_horizon == "auto" and live_intent:
        requested_horizon = "intraday"

    if "refresh_if_missing" in arguments:
        refresh_if_missing = _bool_arg(arguments, "refresh_if_missing", DEFAULT_REFRESH_IF_MISSING)
    else:
        refresh_if_missing = DEFAULT_REFRESH_IF_MISSING or (
            target.get("type") == "us_stock"
            and (requested_horizon == "intraday" or live_intent)
        )
    backend_question = _backend_question(
        question=question,
        target=target,
        analysis_horizon=requested_horizon,
        live_intent=live_intent,
    )

    return {
        "contract_version": "omi.decision.v4",
        "question": backend_question,
        "target": target,
        "mode": mode,
        "intents": arguments.get("intents") or [],
        "output": arguments.get("output"),
        "realtime_policy": arguments.get("realtime_policy") or "prefer_live",
        "selection": arguments.get("selection") or {},
        "continuation": arguments.get("continuation") or {},
        "caller_profile": "omi_search",
        "allow_llm": False,
        "allow_write": False,
        "allow_external_fetch": refresh_if_missing,
        "tool_budget": _tool_budget_arg(arguments, refresh_if_missing=refresh_if_missing),
        "refresh_policy": arguments.get("refresh_policy") or {
            "mode": "stale_first",
            "before_answer": True,
            "fallback_to_cached": True,
        },
        "strategy_profile": arguments.get("strategy_profile", "short_term_momentum"),
        "analysis_horizon": requested_horizon,
        "branch_days": arguments.get("branch_days", 5),
        "rank_by": arguments.get("rank_by", "score"),
        "sort_order": arguments.get("sort_order", "desc"),
        "market_limit": arguments.get("market_limit", 10),
        "context_limit": arguments.get("context_limit", 100),
        "include_children": _bool_arg(arguments, "include_children", True),
        "enabled_only": _bool_arg(arguments, "enabled_only", True),
        "conversation_context": _dict_arg(arguments, "conversation_context"),
        "market_data_params": _market_data_params_arg(arguments),
    }


def _api_post(path: str, payload: dict[str, Any]) -> Any:
    data = json.dumps(_sanitize_json_value(payload), ensure_ascii=False).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}",
    }
    if AI_TRUST_TOKEN:
        headers[AI_TRUST_TOKEN_HEADER] = AI_TRUST_TOKEN

    request = Request(
        f"{API_BASE_URL}{path}",
        data=data,
        headers=headers,
        method="POST",
    )

    try:
        with urlopen(request, timeout=API_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OMI API HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"OMI API unavailable at {API_BASE_URL}: {exc}") from exc

    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OMI API returned non-JSON response: {body[:500]}") from exc


def _path(value: Any, keys: tuple[str, ...]) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _first_dict(*values: Any) -> dict[str, Any]:
    for value in values:
        if isinstance(value, dict) and value:
            return value
    return {}


def _trim_default_value(value: Any, *, key: str | None = None) -> Any:
    if isinstance(value, dict):
        trimmed: dict[str, Any] = {}
        for child_key, child_value in value.items():
            trimmed[str(child_key)] = _trim_default_value(child_value, key=str(child_key))
        return trimmed

    if isinstance(value, list):
        limit = DEFAULT_POINTS_TAIL_LIMIT if key == "points" else DEFAULT_LIST_LIMIT
        if len(value) > limit:
            selected = value[-limit:] if key == "points" else value[:limit]
        else:
            selected = value
        return [_trim_default_value(item) for item in selected]

    return value


def _compact_tool_runs(tool_runs: Any) -> list[dict[str, Any]]:
    if not isinstance(tool_runs, list):
        return []

    compact_runs: list[dict[str, Any]] = []
    for run in tool_runs[:DEFAULT_LIST_LIMIT]:
        if not isinstance(run, dict):
            continue
        compact_run = {
            "tool": run.get("tool"),
            "status": run.get("status"),
            "reason": run.get("reason"),
            "arguments": run.get("arguments"),
            "external_fetch": run.get("external_fetch"),
            "writes_cache": run.get("writes_cache"),
            "result_summary": _trim_default_value(run.get("result_summary") or {}),
            "error": run.get("error"),
            "duration_ms": run.get("duration_ms"),
        }
        compact_runs.append(compact_run)
    return compact_runs


def _first_intraday_series(intraday: dict[str, Any]) -> dict[str, Any]:
    series = intraday.get("series")
    if not isinstance(series, dict):
        if isinstance(intraday.get("points"), list):
            return intraday
        return {}

    preferred = series.get("1m")
    if isinstance(preferred, dict):
        return preferred

    for value in series.values():
        if isinstance(value, dict):
            return value
    return {}


def _latest_intraday_point(intraday: dict[str, Any]) -> dict[str, Any]:
    series = _first_intraday_series(intraday)
    latest = series.get("latest")
    if isinstance(latest, dict):
        return latest

    points = series.get("points")
    if isinstance(points, list) and points:
        last = points[-1]
        if isinstance(last, dict):
            return last
    return {}


def _live_summary(
    *,
    payload: dict[str, Any],
    quote: dict[str, Any],
    intraday: dict[str, Any],
) -> dict[str, Any]:
    target = payload.get("target") or {}
    latest = _latest_intraday_point(intraday)
    series = _first_intraday_series(intraday)
    intraday_enabled = bool(intraday.get("enabled") or series or latest)
    has_quote = bool(quote)

    if has_quote and intraday_enabled:
        live_surface = "quote_intraday"
    elif has_quote:
        live_surface = "quote"
    elif intraday_enabled:
        live_surface = "intraday"
    else:
        live_surface = "none"

    route_hint = (
        "us_stock_compact_live"
        if target.get("type") == "us_stock" and live_surface != "none"
        else "omi_evidence_context"
    )

    return {
        "live_surface": live_surface,
        "route_hint": route_hint,
        "target_type": target.get("type"),
        "symbol": target.get("id") or target.get("symbol"),
        "quote_price": quote.get("price") if quote.get("price") is not None else quote.get("last_price"),
        "quote_time": quote.get("quote_time"),
        "quote_is_realtime": quote.get("is_realtime"),
        "quote_latency_ms": quote.get("latency_ms"),
        "quote_source": quote.get("source"),
        "quote_provider": quote.get("provider"),
        "session_phase": quote.get("session_phase") or series.get("session_phase"),
        "intraday_enabled": intraday_enabled,
        "intraday_interval": series.get("interval"),
        "intraday_latest": latest.get("time"),
        "intraday_latest_price": latest.get("price") if latest.get("price") is not None else latest.get("close"),
        "intraday_point_count": series.get("point_count") or intraday.get("point_count"),
        "background_source_refs_note": (
            "source_refs are background evidence; use quote, intraday, and "
            "compact_evidence.intraday_bars for live quote/intraday status."
        ),
    }


def _compact_search_response(
    *,
    arguments: dict[str, Any],
    payload: dict[str, Any],
    response: Any,
) -> dict[str, Any]:
    if not isinstance(response, dict):
        return {
            "kind": "omi_search",
            "ok": False,
            "query": payload["question"],
            "target": payload["target"],
            "error": "OMI API response was not an object.",
            "raw_response": response,
        }
    if response.get("contract_version") == "omi.decision.v4":
        return response

    analysis = response.get("analysis", {})
    result = response.get("result", {})
    compact_evidence = _first_dict(
        _path(result, ("data", "compact")),
        _path(result, ("compact_evidence",)),
        _path(analysis, ("compact_evidence",)),
    )
    quote = _first_dict(
        _path(compact_evidence, ("quote",)),
        _path(result, ("quote",)),
        _path(result, ("data", "quote")),
    )
    intraday = _first_dict(
        _path(compact_evidence, ("intraday_bars",)),
        _path(compact_evidence, ("intraday_chart",)),
        _path(result, ("intraday",)),
        _path(result, ("data", "intraday_bars")),
        _path(result, ("data", "intraday_chart")),
    )
    result_view = _first_dict(
        _path(result, ("data", "result_view")),
        _path(result, ("result_view",)),
        _path(analysis, ("result_view",)),
    )
    fallback_live_summary = _live_summary(payload=payload, quote=quote, intraday=intraday)
    backend_live_summary = _first_dict(
        _path(result, ("live_summary",)),
        _path(result, ("data", "live_summary")),
        _path(compact_evidence, ("live_summary",)),
    )
    live_summary = {**fallback_live_summary, **backend_live_summary}
    background_source_refs = _trim_default_value(response.get("source_refs", []))
    human_answer = _first_dict(
        _path(analysis, ("human_answer",)),
        _path(result, ("human_answer",)),
        _path(result, ("summary", "human_answer")),
    )
    consumer_result = {
        key: result.get(key)
        for key in (
            "kind",
            "as_of",
            "latest_trade_date",
            "status",
            "target",
            "stock",
            "resolution",
        )
        if result.get(key) is not None
    }
    if human_answer:
        consumer_result["human_answer"] = _trim_default_value(human_answer)
    consumer_result["data"] = _trim_default_value(compact_evidence)

    compact = {
        "kind": "omi_search",
        "ok": response.get("ok") is not False,
        "live_surface": live_summary["live_surface"],
        "route_hint": live_summary["route_hint"],
        "live_summary": live_summary,
        "debug_request_flags": {
            "adapter": "OMI_search",
            "route": "POST /api/ai/ask",
            "route_hint": live_summary["route_hint"],
            "live_surface": live_summary["live_surface"],
            "contract_version": payload.get("contract_version"),
            "mode": payload.get("mode"),
            "caller_profile": payload.get("caller_profile"),
            "allow_llm": payload.get("allow_llm"),
            "allow_write": payload.get("allow_write"),
            "allow_external_fetch": payload.get("allow_external_fetch"),
            "refresh_if_missing": payload.get("allow_external_fetch"),
            "tool_budget": payload.get("tool_budget") or {},
            "target_type": (payload.get("target") or {}).get("type"),
            "symbol": (payload.get("target") or {}).get("id")
            or (payload.get("target") or {}).get("symbol"),
            "analysis_horizon": payload.get("analysis_horizon"),
            "market_data_params": payload.get("market_data_params") or {},
        },
        "query": payload["question"],
        "target": response.get("target") or payload["target"],
        "mode": response.get("mode", {}),
        "action": response.get("action"),
        "answer_ready": response.get("answer_ready", True),
        "facts_ready": response.get("facts_ready", False),
        "analysis_ready": response.get("analysis_ready", False),
        "decision_ready": response.get("decision_ready", False),
        "blocked_sections": response.get("blocked_sections", []),
        "available_sections": response.get("available_sections", []),
        "request_status": response.get("request_status", "completed"),
        "fallback_used": response.get("fallback_used", False),
        "cached_data_returned": response.get("cached_data_returned", False),
        "job": response.get("job", {}),
        "cancellation": response.get("cancellation", {}),
        "report_level": response.get("report_level"),
        "resolution": response.get("resolution", {}),
        "clarification": response.get("clarification", {}),
        "result": consumer_result,
        "compact_evidence_ref": "result.data",
        "quote_ref": "result.data.quote",
        "intraday_ref": (
            "result.data.intraday_chart"
            if isinstance(compact_evidence.get("intraday_chart"), dict)
            else "result.data.intraday_bars"
        ),
        "live_summary_ref": "result.live_summary",
        "result_view": _trim_default_value(result_view),
        "freshness": response.get("freshness", {}),
        "missing": response.get("missing", []),
        "warnings": response.get("warnings", []),
        "tool_plan": response.get("tool_plan", {}),
        "tool_runs": _compact_tool_runs(response.get("tool_runs", [])),
        "source_refs_role": (
            "background_evidence; live quote/intraday status is exposed in "
            "backend live_summary plus the market-specific compact intraday payload"
        ),
        "source_refs": background_source_refs,
        "evidence_passport": response.get("evidence_passport", {}),
        "error": response.get("error", {}),
    }
    if human_answer:
        compact["human_answer_ref"] = "result.human_answer"
    if _bool_arg(arguments, "include_raw", False):
        compact["raw_response"] = response
    return compact


def _search(arguments: dict[str, Any]) -> dict[str, Any]:
    payload = _search_payload(arguments)
    response = _api_post("/api/ai/ask", payload)
    if (
        not isinstance(response, dict)
        or response.get("contract_version") != "omi.decision.v4"
    ):
        raise RuntimeError("OMI backend returned a non-v4 public ask response.")
    return response


def _required_text(arguments: dict[str, Any], key: str) -> str:
    text = str(arguments.get(key) or "").strip()
    if not text:
        raise ValueError(f"Missing required argument: {key}")
    return text


def _shortcut_arguments(
    arguments: dict[str, Any],
    *,
    target: dict[str, Any],
    default_question: str,
    market_data_fields: dict[str, str] | None = None,
) -> dict[str, Any]:
    forwarded = dict(arguments)
    forwarded["target"] = target
    forwarded["mode"] = "data_only"
    if not str(forwarded.get("question") or forwarded.get("query") or "").strip():
        forwarded["question"] = default_question

    if market_data_fields:
        market_data_params = _dict_arg(arguments, "market_data_params")
        for argument_name, parameter_name in market_data_fields.items():
            if argument_name in arguments and arguments[argument_name] is not None:
                market_data_params[parameter_name] = arguments[argument_name]
        forwarded["market_data_params"] = market_data_params
    return forwarded


def _market_overview_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    market = str(arguments.get("market") or "tw").strip().lower() or "tw"
    return _shortcut_arguments(
        arguments,
        target={"type": "market", "market": market},
        default_question=f"Read {market} market overview",
        market_data_fields={"market": "market"},
    )


def _stock_context_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    market = str(arguments.get("market") or "tw").strip().lower() or "tw"
    target_types = {
        "tw": "tw_stock",
        "us": "us_stock",
        "jp": "jp_stock",
        "kr": "kr_stock",
    }
    if market not in target_types:
        raise ValueError("market must be one of: tw, us, jp, kr")
    symbol = _required_text(arguments, "symbol")
    normalized_symbol = symbol if market == "tw" else symbol.upper()
    return _shortcut_arguments(
        arguments,
        target={"type": target_types[market], "id": normalized_symbol},
        default_question=f"Read {market} stock context {normalized_symbol}",
    )


def _data_freshness_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    market = str(arguments.get("market") or "").strip().lower()
    target: dict[str, Any] = {"type": "data_freshness"}
    if market:
        target["market"] = market
    return _shortcut_arguments(
        arguments,
        target=target,
        default_question=(
            f"Read OMI data freshness for {market}"
            if market
            else "Read OMI data freshness"
        ),
        market_data_fields={"market": "market"},
    )


def _source_health_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    market = str(arguments.get("market") or "").strip().lower()
    target: dict[str, Any] = {"type": "source_health"}
    if market:
        target["market"] = market
    target_id = str(arguments.get("target_id") or "").strip()
    if target_id:
        target["id"] = target_id
    return _shortcut_arguments(
        arguments,
        target=target,
        default_question="Read OMI source health",
        market_data_fields={
            "market": "market",
            "provider": "provider",
            "resource": "resource",
            "target_id": "target",
            "status_filter": "status_filter",
            "problems_only": "problems_only",
            "include_healthy": "include_healthy",
            "limit": "health_limit",
        },
    )


def _capability_status_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    capability_id = str(arguments.get("capability_id") or "").strip()
    market = str(arguments.get("market") or "").strip().lower()
    target: dict[str, Any] = {"type": "capability_status"}
    if capability_id:
        target["id"] = capability_id
    if market:
        target["market"] = market
    return _shortcut_arguments(
        arguments,
        target=target,
        default_question="Read OMI capability status",
        market_data_fields={
            "capability_id": "capability_id",
            "market": "market",
            "status": "status",
            "limit": "limit",
        },
    )


def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
    if name == "omi.ask" or name in LEGACY_TOOL_ALIASES:
        return _search(arguments)
    if name == "omi.read_market_overview":
        return _search(_market_overview_arguments(arguments))
    if name == "omi.read_stock_context":
        return _search(_stock_context_arguments(arguments))
    if name == "omi.read_data_freshness":
        return _search(_data_freshness_arguments(arguments))
    if name == "omi.read_source_health":
        return _search(_source_health_arguments(arguments))
    if name == "omi.read_capability_status":
        return _search(_capability_status_arguments(arguments))
    raise KeyError(f"Unknown tool: {name}")


def _handle_request(message: dict[str, Any]) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    if method == "notifications/initialized":
        return None

    if method == "initialize":
        return _response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": SERVER_NAME,
                    "title": "OMI_search MCP Adapter",
                    "version": SERVER_VERSION,
                },
                "instructions": (
                    "Use omi.ask as the canonical read-only OMI entry point. "
                    "Use the read_market_overview, read_stock_context, read_data_freshness, "
                    "read_source_health, and read_capability_status tools only for their "
                    "narrow diagnostic/read shortcuts. "
                    "This adapter is read-only with respect to reports and LLM calls: it always sends "
                    "allow_llm=false and allow_write=false. Setting refresh_if_missing=true only permits "
                    "the trusted OMI backend to attempt its bounded stale-first evidence refresh policy. "
                    "Read execution.refresh_reconciliation for actual attempts and remaining fill actions."
                ),
            },
        )

    if method == "ping":
        return _response(request_id, {})

    if method == "tools/list":
        return _response(request_id, {"tools": TOOLS})

    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _response(
                request_id,
                _tool_result("Tool arguments must be an object.", is_error=True),
            )
        try:
            tool_payload = _call_tool(name, arguments)
            return _response(
                request_id,
                _tool_result(tool_payload, is_error=False),
            )
        except KeyError as exc:
            return _error(request_id, -32602, str(exc))
        except Exception as exc:
            return _response(
                request_id,
                _tool_result({"error": str(exc), "tool": name}, is_error=True),
            )

    if request_id is None:
        return None
    return _error(request_id, -32601, f"Method not found: {method}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            _write(_error(None, -32700, "Parse error", str(exc)))
            continue
        try:
            response = _handle_request(message)
        except Exception as exc:
            response = _error(
                message.get("id") if isinstance(message, dict) else None,
                -32603,
                "Internal error",
                {"error": str(exc), "traceback": traceback.format_exc()},
            )
        if response is not None:
            _write(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
