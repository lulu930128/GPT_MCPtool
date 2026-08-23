from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field

from kgi_broker_bridge.contracts import BrokerAccountRef


@dataclass(frozen=True, slots=True)
class AccountIdentityProjector:
    _key: bytes = field(repr=False)

    def __init__(self, key: str | bytes) -> None:
        material = key.encode("utf-8") if isinstance(key, str) else bytes(key)
        if len(material) < 32:
            raise ValueError("account identity key must contain at least 32 bytes")
        object.__setattr__(self, "_key", material)

    def project(self, raw_account_ref: str) -> BrokerAccountRef:
        normalized = raw_account_ref.strip()
        if not normalized:
            raise ValueError("raw account reference must not be empty")
        digest = hmac.new(self._key, normalized.encode("utf-8"), hashlib.sha256).hexdigest()
        suffix = normalized[-4:] if len(normalized) >= 4 else ""
        masked = f"KGI ••••{suffix}" if suffix else "KGI ••••"
        return BrokerAccountRef(opaque_id=f"kgi_{digest[:24]}", masked_label=masked)
