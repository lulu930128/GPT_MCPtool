from __future__ import annotations

from typing import Literal

DomainTaxonomyStatus = Literal["canonical", "legacy", "custom"]

CANONICAL_DOMAINS = frozenset(
    {
        "general",
        "media",
        "media.galgame",
        "media.anime",
        "media.manga",
        "project.personal",
        "project.work",
        "career",
        "education",
        "language.japanese",
        "finance.investment",
        "health",
        "preference",
    }
)

# These values exist in older data or early examples. Mapping them automatically would
# manufacture semantics, so overview reports them without silently changing stored data.
LEGACY_DOMAINS = frozenset({"entertainment", "study", "work"})


def domain_taxonomy_status(domain: str) -> DomainTaxonomyStatus:
    if domain in CANONICAL_DOMAINS:
        return "canonical"
    if domain in LEGACY_DOMAINS:
        return "legacy"
    return "custom"
