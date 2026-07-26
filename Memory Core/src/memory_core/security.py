from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_token() -> str:
    return f"mcore_{secrets.token_urlsafe(32)}"


@dataclass(frozen=True, slots=True)
class ClientPrincipal:
    id: str
    name: str
    scopes: frozenset[str]

    def has_scope(self, scope: str) -> bool:
        return "*" in self.scopes or scope in self.scopes

    def require(self, *required_scopes: str) -> bool:
        return all(self.has_scope(scope) for scope in required_scopes)
