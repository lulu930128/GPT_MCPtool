from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
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
SERVER_VERSION = "0.3.0"
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
            "refresh. The adapter never infers this value from the question or target."
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


def _build_public_tools(ask_source: dict[str, Any]) -> list[dict[str, Any]]:
    source_schema = ask_source.get("input_schema")
    if not isinstance(source_schema, dict):
        source_schema = ask_source.get("inputSchema")
    ask_schema = _adapter_ask_schema(source_schema)
    ask_tool = {
        "name": "omi.ask",
        "title": str(ask_source.get("title") or "Ask OMI"),
        "description": (
            "Map a read-only MCP request to OMI POST /api/ai/ask and return the "
            "unchanged omi.decision.v4 envelope. OMI backend owns target resolution, "
            "question understanding, freshness, refresh policy, evidence, and answers."
        ),
        "inputSchema": ask_schema,
    }

    market_schema = {
        "type": "string",
        "description": "Market identifier such as tw, us, jp, kr, or crypto.",
    }
    tools = [
        ask_tool,
        {
            "name": "omi.read_market_overview",
            "title": "Read OMI Market Overview",
            "description": "Map a market-overview shortcut to canonical OMI ask.",
            "inputSchema": _shortcut_input_schema(
                ask_schema,
                {"market": {**market_schema, "default": "tw"}},
            ),
        },
        {
            "name": "omi.read_stock_context",
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
            "name": "omi.read_data_freshness",
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
            "name": "omi.read_source_health",
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
            "name": "omi.read_capability_status",
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
    return tools


PUBLIC_TOOLS = _build_public_tools(_fallback_ask_source())
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


def _write(message: dict[str, Any]) -> None:
    safe_message = _sanitize_json_value(message)
    payload = json.dumps(
        safe_message,
        ensure_ascii=False,
        default=_json_default,
        allow_nan=False,
    )
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


def _response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(
    request_id: Any,
    code: int,
    message: str,
    data: Any | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


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
    return _build_public_tools(ask_source)


def _tools_for_client() -> list[dict[str, Any]]:
    try:
        return _backend_public_tools()
    except Exception:
        return PUBLIC_TOOLS


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


def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
    if name == "omi.ask":
        return _search(arguments)
    if name in LEGACY_TOOL_ALIASES:
        return _search(arguments, allow_legacy_aliases=True)
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
                    "The adapter maps MCP fields to POST /api/ai/ask, fixes "
                    "allow_llm=false and allow_write=false, and returns the unchanged "
                    "omi.decision.v4 envelope. OMI backend owns all market and answer "
                    "judgment. refresh_if_missing must be explicit."
                ),
            },
        )

    if method == "ping":
        return _response(request_id, {})

    if method == "tools/list":
        return _response(request_id, {"tools": _tools_for_client()})

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
