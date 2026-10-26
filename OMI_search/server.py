from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
import os
from http.client import HTTPException
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, urlopen
from uuid import UUID

import anyio
import mcp.types as mcp_types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.shared.exceptions import MCPError


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


SERVER_NAME = "omi-search-mcp"
SERVER_VERSION = "1.2.0"
SERVER_TITLE = "OMI_search MCP Adapter"
SERVER_INSTRUCTIONS = (
    "Use omi.ask as the canonical read-only OMI entry point. "
    "Use omi.read_refresh_status for a returned background refresh job. "
    "The adapter maps MCP fields to POST /api/ai/ask, fixes "
    "allow_llm=false and allow_write=false, and returns the unchanged "
    "omi.decision.v4 envelope. OMI backend owns all market and answer "
    "judgment. For CURRENT Taiwan preopen single-stock quote questions "
    "(盤前/試撮/試搓), callers should explicitly select quote.auction as primary: "
    'selection={"include":["quote.auction"],"optional":["quote.snapshot",'
    '"quote.order_book","data.freshness"]}. Preserve the original question. '
    "When a live update is intended and user authorization and policy permit, "
    "use realtime_policy=prefer_live, refresh_if_missing=true (boolean), and a "
    "bounded tool_budget, e.g. max_calls=3, max_external_fetches=2, "
    "max_total_seconds=20. Keep refresh_if_missing=false for cache-only, "
    "retrospective, or explicit no-refresh requests. It defaults to false; "
    "the adapter never infers refresh permission from question text or target. "
    "Refresh permission does not guarantee an auction value. For NO_SNAPSHOT, "
    "use v4 evidence and execution.refresh_reconciliation to distinguish an "
    "unfetched cache from provider unavailable or indicative match unavailable; "
    "a cache miss alone does not prove no market data. A follow-up refresh "
    "requires the same live intent, user authorization and policy permission. "
    "The adapter never rephrases the response. For the Taiwan "
    "dashboard, call omi.read_tw_market_dashboard before "
    "omi.open_tw_market_dashboard. Alternatively, omi_open_tw_workspace opens "
    "an immediate shell with optional initial selection and independent cache-only panes. "
    "Runtime management is a separate protected exception: read status first; only "
    "call omi_restart_backend on an explicit user restart request with the observed "
    "launcher owner UUID and confirmation. HTTP 202 is acceptance, not completion. "
    "After an unknown outcome, read omi_read_runtime_operation with the same request "
    "UUID; never automatically resubmit or generate a replacement UUID."
)
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
TW_DASHBOARD_RESOURCE_URI = "ui://omi/tw-market-dashboard/v2.html"
TW_WORKSPACE_RESOURCE_URI = "ui://omi/tw-workspace/v1.html"
TW_DASHBOARD_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
TW_DASHBOARD_SNAPSHOT_PATH = Path(__file__).with_name(
    "tw_market_dashboard_contract_snapshot.json"
)
TW_DASHBOARD_WIDGET_PATH = (
    Path(__file__).resolve().parent
    / "ui"
    / "tw-market-dashboard"
    / "dist"
    / "index.html"
)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


API_TIMEOUT_SECONDS = _env_int("OMI_SEARCH_API_TIMEOUT_SECONDS", 90)
SCHEMA_TIMEOUT_SECONDS = _env_int("OMI_SEARCH_SCHEMA_TIMEOUT_SECONDS", 2)
ALLOWED_MODES = {"data_only", "brief", "full"}
FORWARDED_FIELDS = (
    "intents",
    "output",
    "realtime_policy",
    "selection",
    "continuation",
    "tool_budget",
    "refresh_policy",
    "strategy_profile",
    "analysis_horizon",
    "branch_days",
    "rank_by",
    "sort_order",
    "market_limit",
    "context_limit",
    "include_children",
    "enabled_only",
    "conversation_context",
    "position_context",
    "market_data_params",
    "payload_level",
    "diagnostics_level",
)


def _load_public_contract_snapshot() -> dict[str, Any]:
    snapshot_path = Path(__file__).with_name("public_contract_snapshot.json")
    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version")
        != "omi.mcp.public_contract_snapshot.v1"
        or not isinstance(payload.get("ask_input_schema"), dict)
    ):
        return {}
    return payload


PUBLIC_CONTRACT_SNAPSHOT = _load_public_contract_snapshot()


def _load_tw_dashboard_contract_snapshot() -> dict[str, Any]:
    try:
        payload = json.loads(
            TW_DASHBOARD_SNAPSHOT_PATH.read_text(encoding="utf-8")
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version")
        != "omi.mcp.tw_market_dashboard_snapshot.v1"
        or not isinstance(payload.get("digest"), str)
    ):
        return {}
    unsigned = {key: value for key, value in payload.items() if key != "digest"}
    encoded = json.dumps(
        unsigned,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if sha256(encoded).hexdigest() != payload["digest"]:
        return {}
    for key in (
        "dashboard_output_schema",
        "symbol_search_output_schema",
        "stock_detail_output_schema",
    ):
        if not isinstance(payload.get(key), dict):
            return {}
    return payload


TW_DASHBOARD_CONTRACT_SNAPSHOT = _load_tw_dashboard_contract_snapshot()


def _fallback_ask_source() -> dict[str, Any]:
    schema = PUBLIC_CONTRACT_SNAPSHOT.get("ask_input_schema")
    if not isinstance(schema, dict):
        schema = {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "target": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "default": "auto"},
                        "id": {"type": "string"},
                        "market": {"type": "string"},
                    },
                },
            },
            "required": ["question"],
            "additionalProperties": False,
        }
    return {
        "name": "omi.ask",
        "title": "Ask OMI",
        "description": "Read the canonical OMI decision envelope.",
        "input_schema": schema,
    }


def _fallback_refresh_status_source() -> dict[str, Any]:
    return {
        "name": "omi.read_refresh_status",
        "title": "Read OMI Refresh Status",
        "description": (
            "Read one redacted ai.tool_refresh background job. Operation "
            "completion never implies fresh evidence; completed jobs return a "
            "cache-only omi.ask resume template."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "integer",
                    "minimum": 1,
                }
            },
            "required": ["job_id"],
            "additionalProperties": False,
        },
    }


def _adapter_ask_schema(source_schema: Any) -> dict[str, Any]:
    schema = deepcopy(source_schema) if isinstance(source_schema, dict) else {}
    if schema.get("type") != "object":
        schema = deepcopy(_fallback_ask_source()["input_schema"])

    properties = schema.setdefault("properties", {})
    if not isinstance(properties, dict):
        properties = {}
        schema["properties"] = properties

    # These are adapter trust-boundary values, not caller-selectable semantics.
    for name in (
        "allow_external_fetch",
        "allow_llm",
        "allow_write",
        "caller_profile",
    ):
        properties.pop(name, None)

    properties["mode"] = {
        "type": "string",
        "enum": sorted(ALLOWED_MODES),
        "default": "data_only",
        "description": (
            "Read-only OMI answer mode. analysis and report are intentionally "
            "not exposed by this adapter."
        ),
    }
    properties["refresh_if_missing"] = {
        "type": "boolean",
        "default": False,
        "description": (
            "Explicitly allow the trusted OMI backend to attempt bounded external "
            "refresh only when a live update is intended and user authorization and "
            "policy permit. For CURRENT Taiwan preopen single-stock quotes, select "
            "quote.auction as primary (selection.include); optionally add "
            "quote.snapshot, quote.order_book, data.freshness (selection.optional). "
            "Use realtime_policy=prefer_live, literal boolean true and a bounded "
            "tool_budget, e.g. max_calls=3, max_external_fetches=2, max_total_seconds=20. "
            "Keep false for cache-only, retrospective, or explicit no-refresh requests. "
            "Default false; only literal boolean true enables permission. The adapter "
            "never infers this value from the question or target. Permission does not "
            "guarantee an auction value; consult v4 evidence and "
            "execution.refresh_reconciliation for the authoritative reason."
        ),
    }
    properties["include_raw"] = {
        "type": "boolean",
        "default": True,
        "deprecated": True,
        "description": (
            "Compatibility-only transport flag. The adapter always returns the "
            "unchanged canonical omi.decision.v4 envelope."
        ),
    }

    market_data_params = properties.get("market_data_params")
    market_properties = (
        market_data_params.get("properties")
        if isinstance(market_data_params, dict)
        else None
    )
    if isinstance(market_properties, dict):
        include_intraday = market_properties.get("include_intraday")
        intraday_limit = market_properties.get("intraday_limit")
        if isinstance(include_intraday, dict):
            properties["include_intraday"] = {
                **deepcopy(include_intraday),
                "description": (
                    "Compatibility alias for "
                    "market_data_params.include_intraday."
                ),
            }
        if isinstance(intraday_limit, dict):
            properties["intraday_limit"] = {
                **deepcopy(intraday_limit),
                "description": (
                    "Compatibility alias for "
                    "market_data_params.intraday_limit."
                ),
            }

    schema["required"] = ["question"]
    schema["additionalProperties"] = False
    return schema


def _shortcut_input_schema(
    ask_schema: dict[str, Any],
    specific_properties: dict[str, Any],
    *,
    required: list[str] | None = None,
) -> dict[str, Any]:
    ask_properties = ask_schema.get("properties")
    ask_properties = ask_properties if isinstance(ask_properties, dict) else {}
    common_names = (
        "question",
        "realtime_policy",
        "selection",
        "continuation",
        "refresh_if_missing",
        "tool_budget",
        "refresh_policy",
        "payload_level",
        "diagnostics_level",
        "include_intraday",
        "intraday_limit",
        "conversation_context",
        "position_context",
        "market_data_params",
        "include_raw",
    )
    properties = {
        name: deepcopy(ask_properties[name])
        for name in common_names
        if name in ask_properties
    }
    properties.update(deepcopy(specific_properties))
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = list(required)
    return schema


def _read_only_annotations() -> dict[str, bool]:
    return {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }


def _build_tw_dashboard_tools() -> list[dict[str, Any]]:
    snapshot = TW_DASHBOARD_CONTRACT_SNAPSHOT
    if not snapshot:
        return []
    dashboard_schema = deepcopy(snapshot["dashboard_output_schema"])
    symbol_schema = deepcopy(snapshot["symbol_search_output_schema"])
    detail_schema = deepcopy(snapshot["stock_detail_output_schema"])
    annotations = _read_only_annotations()
    return [
        {
            "name": "omi_read_tw_market_dashboard",
            "title": "Read OMI Taiwan Market Dashboard",
            "description": (
                "Read the cache-only backend-owned Taiwan market dashboard. "
                "Returns session, freshness, breadth, groups, watchlist, and "
                "truthfully provisional index estimates without rendering UI."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "watchlist_group_id": {
                        "type": "integer",
                        "minimum": 1,
                    },
                    "include_watchlist_children": {
                        "type": "boolean",
                        "default": True,
                    },
                    "watchlist_limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "default": 40,
                    },
                    "group_limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 30,
                        "default": 8,
                    },
                },
                "additionalProperties": False,
            },
            "outputSchema": dashboard_schema,
            "annotations": deepcopy(annotations),
        },
        {
            "name": "omi_open_tw_market_dashboard",
            "title": "Open OMI Taiwan Market Dashboard",
            "description": (
                "Render a dashboard returned by omi.read_tw_market_dashboard. "
                "Call the data tool first, then pass its complete structured "
                "content unchanged as this tool's arguments."
            ),
            "inputSchema": deepcopy(dashboard_schema),
            "outputSchema": deepcopy(dashboard_schema),
            "annotations": deepcopy(annotations),
            "_meta": {
                "ui": {"resourceUri": TW_DASHBOARD_RESOURCE_URI},
                "openai/outputTemplate": TW_DASHBOARD_RESOURCE_URI,
                "openai/toolInvocation/invoking": "Opening Taiwan dashboard…",
                "openai/toolInvocation/invoked": "Taiwan dashboard opened.",
            },
        },
        {
            "name": "omi_search_tw_symbols",
            "title": "Search OMI Taiwan Symbols",
            "description": (
                "Search active Taiwan stock symbols in the OMI local stock "
                "master. This bounded read never refreshes providers."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 80,
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 50,
                        "default": 20,
                    },
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
            "outputSchema": symbol_schema,
            "annotations": deepcopy(annotations),
        },
        {
            "name": "omi_read_tw_stock_dashboard_detail",
            "title": "Read OMI Taiwan Stock Dashboard Detail",
            "description": (
                "Read cache-only OHLC, backend-computed MA5/20/60, and the "
                "canonical OMI technical report for one active Taiwan stock."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "stock_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 20,
                    },
                    "timeframe": {
                        "type": "string",
                        "enum": ["today", "daily", "weekly", "monthly"],
                        "default": "daily",
                    },
                    "bars": {
                        "type": "integer",
                        "minimum": 20,
                        "maximum": 500,
                        "default": 90,
                    },
                },
                "required": ["stock_id"],
                "additionalProperties": False,
            },
            "outputSchema": detail_schema,
            "annotations": deepcopy(annotations),
        },
    ]


TW_DASHBOARD_TOOLS = _build_tw_dashboard_tools()

# Only transport naming differs from the backend-generated catalog. Paths and
# both schemas remain owned by the generator, including future schema changes.
TW_WORKSPACE_ROUTES = {
    tool["name"].replace(".", "_"): deepcopy(tool)
    for tool in TW_DASHBOARD_CONTRACT_SNAPSHOT.get("workspace_tools", [])
}
TW_WORKSPACE_SELECTION_SCHEMA = {
    "type": "object",
    "properties": {
        key: deepcopy(tool["inputSchema"]["properties"][key])
        for tool in TW_WORKSPACE_ROUTES.values()
        for key in ("stock_id", "timeframe", "watchlist_group_id")
        if key in tool["inputSchema"]["properties"]
    },
    "additionalProperties": False,
}


def _build_tw_workspace_tools() -> list[dict[str, Any]]:
    if not TW_WORKSPACE_ROUTES:
        return []
    tools = [
        {**{key: deepcopy(route[key]) for key in (
            "description", "inputSchema", "outputSchema", "annotations"
        )}, "name": name}
        for name, route in TW_WORKSPACE_ROUTES.items()
    ]
    tools.append({
        "name": "omi_open_tw_workspace",
        "title": "Open OMI Taiwan Workspace",
        "description": "Open an immediate Taiwan research shell. Optional initial selection only; no prepared dashboard or backend call is required.",
        "inputSchema": deepcopy(TW_WORKSPACE_SELECTION_SCHEMA),
        "outputSchema": deepcopy(TW_WORKSPACE_SELECTION_SCHEMA),
        "annotations": _read_only_annotations(),
        "_meta": {
            "ui": {"resourceUri": TW_WORKSPACE_RESOURCE_URI},
            "openai/outputTemplate": TW_WORKSPACE_RESOURCE_URI,
        },
    })
    return tools


def _workspace_response_constants(schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Read envelope constants from generated object/RootModel union schemas.

    Resolve only local definitions; this is a transport identity guard, not a
    replacement for the backend's model validation or the SDK output schema.
    """
    def variants(node: dict[str, Any], seen: frozenset[str]) -> list[dict[str, Any]]:
        if "$ref" in node:
            ref = node["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/$defs/") or ref in seen:
                raise RuntimeError("Unsupported generated workspace schema reference")
            target = schema.get("$defs", {}).get(ref[len("#/$defs/"):])
            if not isinstance(target, dict):
                raise RuntimeError("Missing generated workspace schema definition")
            return variants(target, seen | {ref})
        if "anyOf" in node:
            return [item for branch in node["anyOf"] for item in variants(branch, seen)]
        constants = {
            key: value["const"] for key, value in node.get("properties", {}).items()
            if "const" in value
        }
        if not all(key in constants for key in ("kind", "version")):
            raise RuntimeError("Generated workspace schema lacks envelope constants")
        return [constants]

    return variants(schema, frozenset())


def _read_tw_workspace(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    route = TW_WORKSPACE_ROUTES[name]
    if route["method"] != "GET":
        raise RuntimeError("Workspace contract must use cache-only GET routes")
    allowed = route["inputSchema"]["properties"]
    if arguments.keys() - allowed.keys():
        raise ValueError("Unknown workspace argument")
    path = route["path"]
    for key in route["path_parameters"]:
        value = arguments.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"Missing path argument: {key}")
        path = path.replace("{" + key + "}", quote(value, safe=""))
    query = {
        key: str(value).lower() if isinstance(value, bool) else value
        for key, value in arguments.items()
        if key not in route["path_parameters"] and value is not None
    }
    if query:
        path += "?" + urlencode(query)
    response = _api_request(route["method"], path)
    if not isinstance(response, dict) or not any(
        all(type(response.get(key)) is type(value) and response[key] == value
            for key, value in constants.items())
        for constants in _workspace_response_constants(route["outputSchema"])
    ):
        raise RuntimeError("OMI backend returned a malformed workspace response")
    return response


def _build_runtime_tools() -> list[dict[str, Any]]:
    uuid_schema = {"type": "string", "format": "uuid", "pattern": (
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )}
    return [
        {
            "name": "omi_read_runtime_status",
            "title": "Read OMI Runtime Status",
            "description": (
                "Read authoritative omi.runtime-control.v1 status and launcher owner_id UUID. "
                "Preserve serving_backend.writer_preflight, restart.blockers, ownership, readiness "
                "and source loaded identity verbatim. HTTP OK does not mean restart ready. No side effects."
            ),
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": _read_only_annotations(),
        },
        {
            "name": "omi_restart_backend",
            "title": "Restart OMI Backend (disruptive)",
            "description": (
                "Disruptive protected operation. Only on an explicit user request to restart "
                "the OMI backend. Read runtime status first and supply its launcher instance "
                "UUID as expected_owner_id, a request UUID and literal confirmation. "
                "HTTP 202 means queued, not completed. Writer drain or owner mismatch may "
                "block restart. Never auto retry: look up the same request UUID after "
                "timeout/unknown or duplicate requests; do not generate a replacement UUID. "
                "OwnedShutdown transport has source/disposable-fixture evidence only; production "
                "writer admission/drain, launcher approval and startup adoption remain unavailable. "
                "The current backend records receipts/evaluates preflight; safe stop is not enabled."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request_id": deepcopy(uuid_schema),
                    "expected_owner_id": deepcopy(uuid_schema),
                    "confirmation": {"type": "string", "const": "restart_backend"},
                },
                "required": ["request_id", "expected_owner_id", "confirmation"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False, "destructiveHint": True,
                "idempotentHint": True, "openWorldHint": False,
            },
            "_meta": {"omi/runtime-control/disruptive": True},
        },
        {
            "name": "omi_read_runtime_operation",
            "title": "Read OMI Runtime Operation",
            "description": (
                "Read the authoritative durable receipt for an existing request UUID. "
                "Preserve accepted/running/succeeded/failed/blocked/unknown. "
                "Preserve optional backend_preflight, backend_preflight_identity, blockers, null "
                "and opaque extension fields verbatim. Unknown is not permission to resubmit."
            ),
            "inputSchema": {
                "type": "object", "properties": {"request_id": deepcopy(uuid_schema)},
                "required": ["request_id"], "additionalProperties": False,
            },
            "annotations": _read_only_annotations(),
        },
    ]


def _build_public_tools(
    ask_source: dict[str, Any],
    refresh_status_source: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    source_schema = ask_source.get("input_schema")
    if not isinstance(source_schema, dict):
        source_schema = ask_source.get("inputSchema")
    ask_schema = _adapter_ask_schema(source_schema)
    ask_tool = {
        "name": "omi_ask",
        "title": str(ask_source.get("title") or "Ask OMI"),
        "description": (
            "Map a read-only MCP request to OMI POST /api/ai/ask and return the "
            "unchanged omi.decision.v4 envelope. OMI backend owns target resolution, "
            "question understanding, freshness, refresh policy, evidence, and answers."
        ),
        "inputSchema": ask_schema,
    }
    status_source = refresh_status_source or _fallback_refresh_status_source()
    status_schema = status_source.get("input_schema")
    if not isinstance(status_schema, dict):
        status_schema = status_source.get("inputSchema")
    if not isinstance(status_schema, dict):
        status_schema = _fallback_refresh_status_source()["input_schema"]
    refresh_status_tool = {
        "name": "omi_read_refresh_status",
        "title": str(status_source.get("title") or "Read OMI Refresh Status"),
        "description": str(
            status_source.get("description")
            or _fallback_refresh_status_source()["description"]
        ),
        "inputSchema": deepcopy(status_schema),
    }

    market_schema = {
        "type": "string",
        "description": "Market identifier such as tw, us, jp, kr, or crypto.",
    }
    tools = [
        ask_tool,
        refresh_status_tool,
        {
            "name": "omi_read_market_overview",
            "title": "Read OMI Market Overview",
            "description": "Map a market-overview shortcut to canonical OMI ask.",
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {"market": {**market_schema, "default": "tw"}},
            ),
        },
        {
            "name": "omi_read_stock_context",
            "title": "Read OMI Stock Context",
            "description": "Map an explicit market and symbol to canonical OMI ask.",
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {
                    "market": {
                        "type": "string",
                        "enum": ["tw", "us", "jp", "kr"],
                        "default": "tw",
                    },
                    "symbol": {"type": "string", "minLength": 1},
                },
                required=["symbol"],
            ),
        },
        {
            "name": "omi_read_data_freshness",
            "title": "Read OMI Data Freshness",
            "description": (
                "Map a freshness shortcut to canonical OMI ask without hiding "
                "stale, partial, missing, or provider-error states."
            ),
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {"market": market_schema},
            ),
        },
        {
            "name": "omi_read_source_health",
            "title": "Read OMI Source Health",
            "description": "Map source-health filters to canonical OMI ask.",
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {
                    "market": market_schema,
                    "provider": {"type": "string"},
                    "resource": {"type": "string"},
                    "target_id": {"type": "string"},
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
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "default": 100,
                    },
                },
            ),
        },
        {
            "name": "omi_read_capability_status",
            "title": "Read OMI Capability Status",
            "description": "Map capability-status filters to canonical OMI ask.",
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {
                    "capability_id": {"type": "string"},
                    "market": market_schema,
                    "status": {"type": "string"},
                    "enabled_only": deepcopy(
                        ask_schema.get("properties", {}).get(
                            "enabled_only", {"type": "boolean", "default": True}
                        )
                    ),
                    "include_children": deepcopy(
                        ask_schema.get("properties", {}).get(
                            "include_children", {"type": "boolean", "default": True}
                        )
                    ),
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "default": 100,
                    },
                },
            ),
        },
    ]
    return [*tools, *deepcopy(TW_DASHBOARD_TOOLS), *_build_tw_workspace_tools(), *_build_runtime_tools()]


PUBLIC_TOOLS = _build_public_tools(
    _fallback_ask_source(),
    _fallback_refresh_status_source(),
)
TOOLS = PUBLIC_TOOLS
ASK_TOOL = PUBLIC_TOOLS[0]
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
    if isinstance(value, tuple):
        return [_sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        return {
            _replace_surrogates(str(key)): _sanitize_json_value(item)
            for key, item in value.items()
        }
    return value


def _tool_result(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    safe_value = _sanitize_json_value(value)
    text_value = json.dumps(
        safe_value,
        ensure_ascii=False,
        default=_json_default,
        allow_nan=False,
    )
    return {
        "content": [{"type": "text", "text": text_value}],
        "structuredContent": (
            safe_value if isinstance(safe_value, dict) else {"result": safe_value}
        ),
        "isError": bool(is_error),
    }


def _api_request(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout_seconds: int | None = None,
) -> Any:
    data = None
    headers = {
        "Accept": "application/json",
        "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}",
    }
    if payload is not None:
        data = json.dumps(
            _sanitize_json_value(payload), ensure_ascii=False
        ).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if AI_TRUST_TOKEN:
        headers[AI_TRUST_TOKEN_HEADER] = AI_TRUST_TOKEN

    request = Request(
        f"{API_BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(
            request,
            timeout=timeout_seconds or API_TIMEOUT_SECONDS,
        ) as response:
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
        raise RuntimeError(
            f"OMI API returned non-JSON response: {body[:500]}"
        ) from exc


def _api_post(path: str, payload: dict[str, Any]) -> Any:
    return _api_request("POST", path, payload=payload)


def _backend_public_tools() -> list[dict[str, Any]]:
    payload = _api_request(
        "GET",
        "/api/ai/tools",
        timeout_seconds=SCHEMA_TIMEOUT_SECONDS,
    )
    backend_tools = (
        payload.get("tools")
        if isinstance(payload, dict) and isinstance(payload.get("tools"), list)
        else []
    )
    ask_source = next(
        (
            item
            for item in backend_tools
            if isinstance(item, dict) and item.get("name") == "omi.ask"
        ),
        None,
    )
    if ask_source is None:
        raise RuntimeError("OMI backend tool catalog did not expose omi.ask.")
    refresh_status_source = next(
        (
            item
            for item in backend_tools
            if isinstance(item, dict)
            and item.get("name") == "omi.read_refresh_status"
        ),
        None,
    )
    return _build_public_tools(ask_source, refresh_status_source)


def _tools_for_client() -> list[dict[str, Any]]:
    try:
        return _backend_public_tools()
    except Exception:
        return PUBLIC_TOOLS


def _tw_dashboard_resources_for_client() -> list[dict[str, Any]]:
    return [
        {
            "uri": TW_DASHBOARD_RESOURCE_URI,
            "name": "omi-tw-market-dashboard",
            "title": "OMI Taiwan Market Dashboard",
            "description": (
                "Interactive Taiwan preopen and regular-session market dashboard."
            ),
            "mimeType": TW_DASHBOARD_RESOURCE_MIME_TYPE,
        },
        {
            "uri": TW_WORKSPACE_RESOURCE_URI,
            "name": "omi-tw-workspace",
            "title": "OMI Taiwan Workspace",
            "mimeType": TW_DASHBOARD_RESOURCE_MIME_TYPE,
        }
    ]


def _read_tw_dashboard_resource(uri: str) -> dict[str, Any]:
    if uri not in {TW_DASHBOARD_RESOURCE_URI, TW_WORKSPACE_RESOURCE_URI}:
        raise KeyError(f"Unknown resource: {uri}")
    try:
        widget_html = TW_DASHBOARD_WIDGET_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            "Taiwan dashboard widget bundle is unavailable. Run its production build."
        ) from exc
    if uri == TW_WORKSPACE_RESOURCE_URI:
        widget_html = widget_html.replace('<html ', '<html data-omi-workspace="true" ', 1)
    return {
        "contents": [
            {
                "uri": uri,
                "mimeType": TW_DASHBOARD_RESOURCE_MIME_TYPE,
                "text": widget_html,
                "_meta": {
                    "ui": {
                        "prefersBorder": True,
                        "csp": {
                            "connectDomains": [],
                            "resourceDomains": [],
                        },
                    },
                    "openai/widgetDescription": (
                        "OMI Taiwan market dashboard with truthful freshness, "
                        "coverage, watchlist, and provisional index limitations."
                    ),
                    "openai/widgetPrefersBorder": True,
                    "openai/widgetCSP": {
                        "connect_domains": [],
                        "resource_domains": [],
                    },
                },
            }
        ]
    }


def _bounded_integer(
    arguments: dict[str, Any],
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = arguments.get(key, default)
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        raise ValueError(f"{key} must be an integer from {minimum} to {maximum}")
    return value


def _read_tw_market_dashboard(arguments: dict[str, Any]) -> dict[str, Any]:
    group_id = arguments.get("watchlist_group_id")
    if group_id is not None and (
        isinstance(group_id, bool)
        or not isinstance(group_id, int)
        or group_id < 1
    ):
        raise ValueError("watchlist_group_id must be a positive integer")
    include_children = arguments.get("include_watchlist_children", True)
    if not isinstance(include_children, bool):
        raise ValueError("include_watchlist_children must be a boolean")
    query: dict[str, Any] = {
        "include_watchlist_children": str(include_children).lower(),
        "watchlist_limit": _bounded_integer(
            arguments,
            "watchlist_limit",
            default=40,
            minimum=1,
            maximum=100,
        ),
        "group_limit": _bounded_integer(
            arguments,
            "group_limit",
            default=8,
            minimum=1,
            maximum=30,
        ),
    }
    if group_id is not None:
        query["watchlist_group_id"] = group_id
    response = _api_request(
        "GET",
        f"/api/market/tw-dashboard/snapshot?{urlencode(query)}",
    )
    if (
        not isinstance(response, dict)
        or response.get("kind") != "omi.tw_market_dashboard"
        or response.get("version") != "omi.tw_market_dashboard.v1"
    ):
        raise RuntimeError(
            "OMI backend returned a malformed Taiwan dashboard response."
        )
    return response


def _search_tw_symbols(arguments: dict[str, Any]) -> dict[str, Any]:
    keyword = _required_text(arguments, "keyword")
    if len(keyword) > 80:
        raise ValueError("keyword must be at most 80 characters")
    limit = _bounded_integer(
        arguments,
        "limit",
        default=20,
        minimum=1,
        maximum=50,
    )
    response = _api_request(
        "GET",
        "/api/market/tw-dashboard/symbols/search?"
        + urlencode({"keyword": keyword, "limit": limit}),
    )
    if (
        not isinstance(response, dict)
        or response.get("kind") != "omi.tw_symbol_search"
        or response.get("version") != "omi.tw_symbol_search.v1"
    ):
        raise RuntimeError(
            "OMI backend returned a malformed Taiwan symbol-search response."
        )
    return response


def _read_tw_stock_dashboard_detail(
    arguments: dict[str, Any],
) -> dict[str, Any]:
    stock_id = _required_text(arguments, "stock_id")
    if len(stock_id) > 20:
        raise ValueError("stock_id must be at most 20 characters")
    timeframe = str(arguments.get("timeframe") or "daily").strip().lower()
    if timeframe not in {"today", "daily", "weekly", "monthly"}:
        raise ValueError(
            "timeframe must be one of: today, daily, weekly, monthly"
        )
    bars = _bounded_integer(
        arguments,
        "bars",
        default=90,
        minimum=20,
        maximum=500,
    )
    response = _api_request(
        "GET",
        f"/api/market/tw-dashboard/stocks/{quote(stock_id, safe='')}?"
        + urlencode({"timeframe": timeframe, "bars": bars}),
    )
    if (
        not isinstance(response, dict)
        or response.get("kind") != "omi.tw_stock_dashboard_detail"
        or response.get("version") != "omi.tw_stock_dashboard_detail.v2"
    ):
        raise RuntimeError(
            "OMI backend returned a malformed Taiwan stock-detail response."
        )
    return response


def _open_tw_market_dashboard(arguments: dict[str, Any]) -> dict[str, Any]:
    if (
        arguments.get("kind") != "omi.tw_market_dashboard"
        or arguments.get("version") != "omi.tw_market_dashboard.v1"
    ):
        raise ValueError(
            "Pass the complete omi.read_tw_market_dashboard structuredContent unchanged."
        )
    return deepcopy(arguments)


def _required_question(
    arguments: dict[str, Any], *, allow_legacy_aliases: bool
) -> str:
    if "question" in arguments:
        value = arguments["question"]
    elif allow_legacy_aliases and "query" in arguments:
        value = arguments["query"]
    else:
        raise ValueError("Missing required argument: question")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Missing required argument: question")
    return value


def _explicit_refresh(arguments: dict[str, Any]) -> bool:
    if "refresh_if_missing" not in arguments:
        return False
    value = arguments["refresh_if_missing"]
    if not isinstance(value, bool):
        raise ValueError("refresh_if_missing must be a boolean")
    return value


def _search_payload(
    arguments: dict[str, Any], *, allow_legacy_aliases: bool = False
) -> dict[str, Any]:
    mode = arguments.get("mode", "data_only")
    if not isinstance(mode, str) or mode not in ALLOWED_MODES:
        raise ValueError("mode must be one of: data_only, brief, full")

    payload: dict[str, Any] = {
        "contract_version": "omi.decision.v4",
        "question": _required_question(
            arguments, allow_legacy_aliases=allow_legacy_aliases
        ),
        "mode": mode,
        "caller_profile": "omi_search",
        "allow_llm": False,
        "allow_write": False,
        "allow_external_fetch": _explicit_refresh(arguments),
    }

    if "target" in arguments:
        payload["target"] = deepcopy(arguments["target"])
    elif allow_legacy_aliases:
        stock_id = arguments.get("stock_id")
        symbol = arguments.get("symbol")
        if isinstance(stock_id, str) and stock_id.strip():
            payload["target"] = {"type": "tw_stock", "id": stock_id}
        elif isinstance(symbol, str) and symbol.strip():
            payload["target"] = {"type": "us_stock", "id": symbol}

    for name in FORWARDED_FIELDS:
        if name in arguments:
            payload[name] = deepcopy(arguments[name])

    alias_values = {
        name: arguments[name]
        for name in ("include_intraday", "intraday_limit")
        if name in arguments
    }
    if alias_values:
        params = payload.get("market_data_params")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise ValueError(
                "market_data_params must be an object when compatibility aliases are used"
            )
        params = deepcopy(params)
        for name, value in alias_values.items():
            params.setdefault(name, deepcopy(value))
        payload["market_data_params"] = params

    return payload


def _search(
    arguments: dict[str, Any], *, allow_legacy_aliases: bool = False
) -> dict[str, Any]:
    payload = _search_payload(
        arguments, allow_legacy_aliases=allow_legacy_aliases
    )
    response = _api_post("/api/ai/ask", payload)
    if (
        not isinstance(response, dict)
        or response.get("contract_version") != "omi.decision.v4"
    ):
        raise RuntimeError("OMI backend returned a non-v4 public ask response.")
    return response


def _read_refresh_status(arguments: dict[str, Any]) -> dict[str, Any]:
    job_id = arguments.get("job_id")
    if isinstance(job_id, bool) or not isinstance(job_id, int) or job_id < 1:
        raise ValueError("job_id must be a positive integer")
    response = _api_request("GET", f"/api/ai/refresh-status/{job_id}")
    if not isinstance(response, dict):
        raise RuntimeError("OMI backend returned a malformed refresh-status response.")
    return response


def _required_text(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing required argument: {key}")
    return value


def _shortcut_arguments(
    arguments: dict[str, Any],
    *,
    target: dict[str, Any],
    default_question: str,
    market_data_fields: dict[str, str] | None = None,
) -> dict[str, Any]:
    forwarded = dict(arguments)
    forwarded["target"] = deepcopy(target)
    forwarded["mode"] = "data_only"
    if "question" not in forwarded:
        forwarded["question"] = default_question

    if market_data_fields:
        raw_params = arguments.get("market_data_params")
        if raw_params is None:
            market_data_params: dict[str, Any] = {}
        elif isinstance(raw_params, dict):
            market_data_params = deepcopy(raw_params)
        else:
            raise ValueError("market_data_params must be an object")
        for argument_name, parameter_name in market_data_fields.items():
            if argument_name in arguments and arguments[argument_name] is not None:
                market_data_params[parameter_name] = deepcopy(
                    arguments[argument_name]
                )
        if market_data_params:
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
    return _shortcut_arguments(
        arguments,
        target={"type": target_types[market], "id": symbol},
        default_question=f"Read {market} stock context {symbol}",
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
    target_id = arguments.get("target_id")
    if isinstance(target_id, str) and target_id.strip():
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
    capability_id = arguments.get("capability_id")
    market = str(arguments.get("market") or "").strip().lower()
    target: dict[str, Any] = {"type": "capability_status"}
    if isinstance(capability_id, str) and capability_id.strip():
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


class RuntimeControlError(RuntimeError):
    """Only fixed, credential-free adapter diagnostics may cross the MCP boundary."""

    def __init__(self, code: str, *, request_id: str | None = None, unknown: bool = False):
        super().__init__(code)
        self.payload = {"error": code, "transport_status": "error"}
        if request_id is not None:
            self.payload["request_id"] = request_id
        if unknown:
            self.payload.update(outcome="unknown", next_action="read_runtime_operation_same_request_id")


class _RuntimeNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A management credential must never follow a redirect (including 307/308).
        return None


def _runtime_uuid(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    try:
        if not isinstance(value, str) or str(UUID(value)) != value.lower():
            raise ValueError
    except (ValueError, AttributeError):
        raise RuntimeControlError("INVALID_RUNTIME_UUID") from None
    return value


def _runtime_contains_secret(value: Any, secret: str) -> bool:
    if not secret:
        return False
    if isinstance(value, str):
        return secret in value
    if isinstance(value, list):
        return any(_runtime_contains_secret(item, secret) for item in value)
    if isinstance(value, dict):
        return any(_runtime_contains_secret(item, secret) for pair in value.items() for item in pair)
    return False


def _runtime_request(method: str, path: str, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Single fixed-route request; no AI trust, proxies, redirects, retries or raw errors."""
    request_id = payload["request_id"] if payload else None
    is_restart = method == "POST"
    secret = os.environ.get("OMI_SEARCH_RUNTIME_CONTROL_TOKEN", "")
    if is_restart and (len(secret) != 64 or any(char not in "0123456789abcdef" for char in secret)):
        raise RuntimeControlError("RUNTIME_CONTROL_TOKEN_MISSING_OR_INVALID", request_id=request_id)
    headers = {"Accept": "application/json", "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}"}
    if is_restart:
        headers["X-OMI-Runtime-Control-Token"] = secret
        headers["Content-Type"] = "application/json"
    try:
        base = urlsplit(API_BASE_URL)
        if (base.scheme not in {"http", "https"} or base.hostname not in {"127.0.0.1", "localhost", "::1"}
                or base.username is not None or base.password is not None
                or base.path or base.query or base.fragment):
            raise ValueError
        request = Request(f"{API_BASE_URL}{path}", method=method, headers=headers,
                          data=json.dumps(payload).encode("utf-8") if payload else None)
    except (ValueError, TypeError):
        raise RuntimeControlError("INVALID_RUNTIME_BACKEND_URL", request_id=request_id) from None
    try:
        opener = build_opener(ProxyHandler({}), _RuntimeNoRedirect())
        try:
            response = opener.open(request, timeout=API_TIMEOUT_SECONDS)
        except HTTPError as exc:
            response = exc
        with response:
            status = response.code
            raw = response.read()
    except (TimeoutError, URLError, OSError, HTTPException) as exc:
        timed_out = isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError)
        raise RuntimeControlError("RUNTIME_TIMEOUT" if timed_out else "RUNTIME_UNAVAILABLE",
                                  request_id=request_id, unknown=is_restart) from None
    except Exception:
        raise RuntimeControlError("RUNTIME_TRANSPORT_ERROR", request_id=request_id, unknown=is_restart) from None
    try:
        body = json.loads(raw.decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError
        # Validate serializability here so the shared MCP handler cannot echo a secret.
        json.dumps(body, allow_nan=False)
    except (UnicodeError, ValueError, TypeError):
        raise RuntimeControlError("INVALID_RUNTIME_RESPONSE", request_id=request_id, unknown=is_restart) from None
    if _runtime_contains_secret(body, secret):
        raise RuntimeControlError("RUNTIME_RESPONSE_REDACTED", request_id=request_id, unknown=is_restart)
    return {"transport_status": "http_response", "http_status": status, "response": body}


def _call_runtime_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "omi_read_runtime_status":
        if arguments:
            raise RuntimeControlError("UNEXPECTED_RUNTIME_ARGUMENTS")
        return _runtime_request("GET", "/api/system/runtime-control/status")
    keys = {"request_id", "expected_owner_id", "confirmation"} if name == "omi_restart_backend" else {"request_id"}
    if arguments.keys() != keys:
        raise RuntimeControlError("INVALID_RUNTIME_ARGUMENTS")
    request_id = _runtime_uuid(arguments, "request_id")
    if name == "omi_read_runtime_operation":
        return _runtime_request("GET", f"/api/system/runtime-control/operations/{request_id}")
    owner_id = _runtime_uuid(arguments, "expected_owner_id")
    if arguments["confirmation"] != "restart_backend":
        raise RuntimeControlError("INVALID_RUNTIME_CONFIRMATION", request_id=request_id)
    return _runtime_request("POST", "/api/system/runtime-control/restart-backend", payload={
        "request_id": request_id, "expected_owner_id": owner_id, "confirmation": "restart_backend",
    })


def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
    if name in {"omi_read_runtime_status", "omi_restart_backend", "omi_read_runtime_operation"}:
        return _call_runtime_tool(name, arguments)
    if name in TW_WORKSPACE_ROUTES:
        return _read_tw_workspace(name, arguments)
    if name == "omi_open_tw_workspace":
        if arguments.keys() - TW_WORKSPACE_SELECTION_SCHEMA["properties"].keys():
            raise ValueError("Only initial workspace selection is accepted")
        return deepcopy(arguments)
    if name == "omi_read_tw_market_dashboard":
        return _read_tw_market_dashboard(arguments)
    if name == "omi_open_tw_market_dashboard":
        return _open_tw_market_dashboard(arguments)
    if name == "omi_search_tw_symbols":
        return _search_tw_symbols(arguments)
    if name == "omi_read_tw_stock_dashboard_detail":
        return _read_tw_stock_dashboard_detail(arguments)
    if name == "omi_ask":
        return _search(arguments)
    if name == "omi_read_refresh_status":
        return _read_refresh_status(arguments)
    if name in LEGACY_TOOL_ALIASES:
        return _search(arguments, allow_legacy_aliases=True)
    if name == "omi_read_market_overview":
        return _search(_market_overview_arguments(arguments))
    if name == "omi_read_stock_context":
        return _search(_stock_context_arguments(arguments))
    if name == "omi_read_data_freshness":
        return _search(_data_freshness_arguments(arguments))
    if name == "omi_read_source_health":
        return _search(_source_health_arguments(arguments))
    if name == "omi_read_capability_status":
        return _search(_capability_status_arguments(arguments))
    raise KeyError(f"Unknown tool: {name}")


def _mcp_tool(tool: dict[str, Any], *, protocol_version: str) -> mcp_types.Tool:
    if (
        protocol_version in {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
        and tool["name"] == "omi_read_tw_stock_research"
        and "type" not in tool["outputSchema"]
    ):
        # Both generated anyOf branches are objects. Legacy MCP requires that
        # redundant root type explicitly; retain every $ref/$defs and leave the
        # backend-owned catalog and modern wire schema untouched.
        tool = deepcopy(tool)
        tool["outputSchema"]["type"] = "object"
    return mcp_types.Tool.model_validate(tool)


def _mcp_tool_result(value: Any, *, is_error: bool = False) -> mcp_types.CallToolResult:
    return mcp_types.CallToolResult.model_validate(
        _tool_result(value, is_error=is_error)
    )


async def _on_list_tools(
    context: Any,
    _params: mcp_types.PaginatedRequestParams | None,
) -> mcp_types.ListToolsResult:
    tools = await anyio.to_thread.run_sync(_tools_for_client)
    return mcp_types.ListToolsResult(tools=[
        _mcp_tool(tool, protocol_version=context.protocol_version) for tool in tools
    ])


async def _on_call_tool(
    _context: Any,
    params: mcp_types.CallToolRequestParams,
) -> mcp_types.CallToolResult:
    name = params.name
    arguments = params.arguments or {}
    if not isinstance(arguments, dict):
        return _mcp_tool_result(
            {"error": "Tool arguments must be an object.", "tool": name},
            is_error=True,
        )
    try:
        payload = await anyio.to_thread.run_sync(
            lambda: _call_tool(name, arguments)
        )
        return _mcp_tool_result(payload, is_error=False)
    except RuntimeControlError as exc:
        return _mcp_tool_result(exc.payload, is_error=True)
    except Exception as exc:
        return _mcp_tool_result(
            {"error": str(exc), "tool": name},
            is_error=True,
        )


async def _on_list_resources(
    _context: Any,
    _params: mcp_types.PaginatedRequestParams | None,
) -> mcp_types.ListResourcesResult:
    return mcp_types.ListResourcesResult(
        resources=[
            mcp_types.Resource.model_validate(resource)
            for resource in _tw_dashboard_resources_for_client()
        ]
    )


async def _on_read_resource(
    _context: Any,
    params: mcp_types.ReadResourceRequestParams,
) -> mcp_types.ReadResourceResult:
    try:
        result = await anyio.to_thread.run_sync(
            lambda: _read_tw_dashboard_resource(str(params.uri))
        )
    except KeyError as exc:
        raise MCPError(mcp_types.INVALID_PARAMS, str(exc)) from exc
    return mcp_types.ReadResourceResult.model_validate(result)


def build_mcp_server() -> Server[Any]:
    """Build the official low-level MCP server over the thin adapter core."""
    return Server(
        SERVER_NAME,
        version=SERVER_VERSION,
        title=SERVER_TITLE,
        instructions=SERVER_INSTRUCTIONS,
        on_list_tools=_on_list_tools,
        on_call_tool=_on_call_tool,
        on_list_resources=_on_list_resources,
        on_read_resource=_on_read_resource,
    )


async def _run_stdio() -> None:
    mcp_server = build_mcp_server()
    async with stdio_server() as (read_stream, write_stream):
        await mcp_server.run(
            read_stream,
            write_stream,
            mcp_server.create_initialization_options(),
        )


def main() -> int:
    anyio.run(_run_stdio)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
