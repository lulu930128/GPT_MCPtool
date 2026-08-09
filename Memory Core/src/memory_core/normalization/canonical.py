from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any

_WHITESPACE = re.compile(r"\s+")


def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_digest(value: object) -> str:
    encoded = canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def normalize_display_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return _WHITESPACE.sub(" ", normalized).strip()


def normalize_identity_text(value: str) -> str:
    return normalize_display_text(value).casefold()


def json_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object.")
    return value
