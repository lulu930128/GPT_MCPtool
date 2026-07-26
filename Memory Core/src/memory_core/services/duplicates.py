from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.models import Entity, Record
from memory_core.schemas import DuplicateFinding, DuplicateScanResult

MAX_DUPLICATE_SCAN_ITEMS = 1_000
MAX_CATALOG_IDENTITIES_PER_RECORD = 500
MIN_CONTAINMENT_IDENTITY_LENGTH = 6
_IDENTITY_SEPARATORS = re.compile(r"[\W_]+", flags=re.UNICODE)


def detect_duplicates(
    session: Session,
    *,
    allow_restricted: bool,
    limit: int,
) -> DuplicateScanResult:
    record_statement = (
        select(Record)
        .where(
            Record.deleted_at.is_(None),
            Record.lifecycle_status != "superseded",
        )
        .order_by(Record.updated_at.desc())
        .limit(MAX_DUPLICATE_SCAN_ITEMS + 1)
    )
    entity_statement = (
        select(Entity)
        .where(Entity.deleted_at.is_(None))
        .order_by(Entity.updated_at.desc())
        .limit(MAX_DUPLICATE_SCAN_ITEMS + 1)
    )
    if not allow_restricted:
        record_statement = record_statement.where(
            Record.sensitivity != "restricted",
            Record.handling_policy != "company_restricted",
        )
        entity_statement = entity_statement.where(
            Entity.sensitivity != "restricted",
            Entity.handling_policy != "company_restricted",
        )

    raw_records = list(session.scalars(record_statement))
    raw_entities = list(session.scalars(entity_statement))
    scan_truncated = (
        len(raw_records) > MAX_DUPLICATE_SCAN_ITEMS or len(raw_entities) > MAX_DUPLICATE_SCAN_ITEMS
    )
    records = raw_records[:MAX_DUPLICATE_SCAN_ITEMS]
    entities = raw_entities[:MAX_DUPLICATE_SCAN_ITEMS]

    findings = [
        *_entity_findings(entities),
        *_record_canonical_findings(records),
        *_record_title_findings(records),
        *_record_catalog_findings(records),
    ]
    confidence_order = {"high": 0, "medium": 1}
    findings.sort(
        key=lambda item: (
            confidence_order[item.confidence],
            item.finding_type,
            item.refs,
        )
    )
    findings_truncated = len(findings) > limit
    return DuplicateScanResult(
        generated_at=utc_now(),
        scanned_records=len(records),
        scanned_entities=len(entities),
        scan_truncated=scan_truncated,
        findings_truncated=findings_truncated,
        findings=findings[:limit],
    )


def _entity_findings(entities: list[Entity]) -> list[DuplicateFinding]:
    groups: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for entity in entities:
        for field_name, value in _entity_identity_values(entity):
            key = _identity_key(value)
            if key:
                groups[key].append((entity.id, field_name))

    findings: list[DuplicateFinding] = []
    seen_groups: set[tuple[str, ...]] = set()
    for matches in groups.values():
        entity_ids = tuple(sorted({entity_id for entity_id, _field_name in matches}))
        if len(entity_ids) < 2 or entity_ids in seen_groups:
            continue
        seen_groups.add(entity_ids)
        findings.append(
            DuplicateFinding(
                finding_type="entity_identity_overlap",
                refs=[f"entity:{entity_id}" for entity_id in entity_ids],
                confidence="high",
                matched_on=sorted({field_name for _entity_id, field_name in matches}),
            )
        )
    return findings


def _record_canonical_findings(records: list[Record]) -> list[DuplicateFinding]:
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    for record in records:
        canonical_ref = record.payload.get("canonical_entity_ref")
        if isinstance(canonical_ref, str) and canonical_ref.startswith("entity:"):
            groups[(record.schema_name, canonical_ref)].append(record.id)
    return [
        DuplicateFinding(
            finding_type="record_canonical_overlap",
            refs=[f"record:{record_id}" for record_id in sorted(set(record_ids))],
            confidence="high",
            matched_on=["schema_name", "canonical_entity_ref"],
        )
        for record_ids in groups.values()
        if len(set(record_ids)) >= 2
    ]


def _record_title_findings(records: list[Record]) -> list[DuplicateFinding]:
    groups: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for record in records:
        title_key = _identity_key(record.title)
        if title_key:
            groups[(record.domain, record.schema_name, title_key)].append(record.id)
    return [
        DuplicateFinding(
            finding_type="record_title_overlap",
            refs=[f"record:{record_id}" for record_id in sorted(set(record_ids))],
            confidence="medium",
            matched_on=["domain", "schema_name", "title"],
        )
        for record_ids in groups.values()
        if len(set(record_ids)) >= 2
    ]


def _record_catalog_findings(records: list[Record]) -> list[DuplicateFinding]:
    catalog_values: list[tuple[str, str]] = []
    experience_values: list[tuple[str, str]] = []
    for record in records:
        if record.schema_name.endswith("_catalog"):
            categories = record.payload.get("categories")
            for catalog_value in _nested_strings(
                categories,
                limit=MAX_CATALOG_IDENTITIES_PER_RECORD,
            ):
                key = _identity_key(catalog_value)
                if key:
                    catalog_values.append((record.id, key))
            continue
        for field_name in ("work_title", "canonical_title"):
            experience_value = record.payload.get(field_name)
            if isinstance(experience_value, str):
                key = _identity_key(experience_value)
                if key:
                    experience_values.append((record.id, key))

    findings: list[DuplicateFinding] = []
    seen_pairs: set[tuple[str, str]] = set()
    for experience_id, experience_key in experience_values:
        for catalog_id, catalog_key in catalog_values:
            if experience_id == catalog_id:
                continue
            exact = experience_key == catalog_key
            contained = (
                len(experience_key) >= MIN_CONTAINMENT_IDENTITY_LENGTH
                and experience_key in catalog_key
            )
            if not exact and not contained:
                continue
            first_id, second_id = sorted((experience_id, catalog_id))
            pair = (first_id, second_id)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            findings.append(
                DuplicateFinding(
                    finding_type="record_catalog_item_overlap",
                    refs=[f"record:{record_id}" for record_id in pair],
                    confidence="high" if exact else "medium",
                    matched_on=["payload.categories", "payload.work_title"],
                )
            )
    return findings


def _entity_identity_values(entity: Entity) -> Iterable[tuple[str, str]]:
    yield "name", entity.name
    if entity.canonical_name:
        yield "canonical_name", entity.canonical_name
    aliases = entity.payload.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            if isinstance(alias, str):
                yield "aliases", alias


def _identity_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return _IDENTITY_SEPARATORS.sub("", normalized)


def _nested_strings(value: object, *, limit: int) -> Iterable[str]:
    pending = [value]
    yielded = 0
    while pending and yielded < limit:
        current = pending.pop()
        if isinstance(current, str):
            yielded += 1
            yield current
        elif isinstance(current, list):
            pending.extend(reversed(current))
        elif isinstance(current, dict):
            pending.extend(reversed(list(current.values())))
