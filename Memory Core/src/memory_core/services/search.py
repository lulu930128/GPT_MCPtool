from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import case, func, literal, or_, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import InstrumentedAttribute
from sqlalchemy.sql.elements import ColumnElement

from memory_core.models import Entity, Record
from memory_core.schemas import SearchResult

MAX_QUERY_TOKENS = 20
_QUERY_SEPARATORS = re.compile(r"""[\s,，。！？?!；;：:、/／|｜()（）[\]{}「」『』《》〈〉]+""")
_QUERY_WHITESPACE = re.compile(r"\s+")
_QUERY_PREFIX = re.compile(
    r"^(?:請問|請幫我|幫我|使用者|我)(?=(?:玩過|看過|讀過|完成|完食|有|目前|正在|喜歡|想)|\s)"
)
_QUERY_PHRASES_TO_REMOVE = (
    "有哪些",
    "有什麼",
    "玩過的",
    "看過的",
    "讀過的",
    "已經",
    "哪些",
)
_QUERY_CONNECTORS = ("與",)
_STOP_TOKENS = {
    "the",
    "what",
    "which",
    "my",
    "have",
    "has",
    "please",
    "我",
    "使用者",
    "請",
    "請問",
    "幫我",
    "哪些",
    "有哪些",
    "什麼",
    "有什麼",
    "已經",
    "嗎",
    "呢",
}


@dataclass(frozen=True, slots=True)
class SearchFilters:
    result_type: Literal["record", "entity"] | None = None
    domain: str | None = None
    schema_name: str | None = None
    kind: str | None = None
    sensitivity: str | None = None
    updated_after: datetime | None = None
    updated_before: datetime | None = None


def search_memory(
    session: Session,
    query: str,
    *,
    allow_restricted: bool,
    limit: int = 30,
    filters: SearchFilters | None = None,
) -> list[SearchResult]:
    filters = filters or SearchFilters()
    normalized = _normalize_query(query)
    if not normalized:
        return []

    tokens = _query_tokens(normalized)
    if not tokens:
        return []
    if len(tokens) > 1:
        records = (
            _search_records_by_tokens(
                session,
                normalized,
                tokens,
                allow_restricted=allow_restricted,
                limit=limit,
                minimum_matches=_minimum_token_matches(tokens),
                filters=filters,
            )
            if filters.result_type != "entity"
            else []
        )
        token_entities = (
            _search_entities_by_tokens(
                session,
                normalized,
                tokens,
                allow_restricted=allow_restricted,
                limit=limit,
                minimum_matches=_minimum_token_matches(tokens),
                filters=filters,
            )
            if (
                filters.result_type != "record"
                and filters.domain is None
                and filters.schema_name is None
            )
            else []
        )
        strategy = "token_coverage"
        if not records and not token_entities:
            fallback_tokens = _fallback_tokens(tokens)
            if fallback_tokens:
                records = (
                    _search_records_by_tokens(
                        session,
                        normalized,
                        fallback_tokens,
                        allow_restricted=allow_restricted,
                        limit=limit,
                        minimum_matches=1,
                        filters=filters,
                    )
                    if filters.result_type != "entity"
                    else []
                )
                token_entities = (
                    _search_entities_by_tokens(
                        session,
                        normalized,
                        fallback_tokens,
                        allow_restricted=allow_restricted,
                        limit=limit,
                        minimum_matches=1,
                        filters=filters,
                    )
                    if (
                        filters.result_type != "record"
                        and filters.domain is None
                        and filters.schema_name is None
                    )
                    else []
                )
                tokens = fallback_tokens
                strategy = "token_fallback"
        return _merge_ranked_results(
            records,
            token_entities,
            normalized=normalized,
            tokens=tokens,
            strategy=strategy,
            limit=limit,
        )

    records = (
        _search_records_fts(
            session,
            normalized,
            allow_restricted=allow_restricted,
            limit=limit,
            filters=filters,
        )
        if filters.result_type != "entity"
        else []
    )
    if not records:
        pattern = _like_pattern(normalized)
        record_statement = select(Record).where(
            Record.deleted_at.is_(None),
            Record.lifecycle_status != "superseded",
            *_record_filter_clauses(filters),
            or_(
                _contains(Record.title, pattern),
                _contains(Record.summary, pattern),
                _contains(Record.body_markdown, pattern),
                _contains(Record.payload, pattern),
            ),
        )
        if not allow_restricted:
            record_statement = record_statement.where(
                Record.sensitivity != "restricted",
                Record.handling_policy != "company_restricted",
            )
        records = list(
            session.scalars(record_statement.order_by(Record.updated_at.desc()).limit(limit))
        )

    remaining = max(limit - len(records), 0)
    entities: list[Entity] = []
    if (
        remaining
        and filters.result_type != "record"
        and filters.domain is None
        and filters.schema_name is None
    ):
        pattern = _like_pattern(normalized)
        entity_statement = select(Entity).where(
            Entity.deleted_at.is_(None),
            *_entity_filter_clauses(filters),
            or_(
                _contains(Entity.name, pattern),
                _contains(Entity.canonical_name, pattern),
                _contains(Entity.description, pattern),
                _contains(Entity.payload, pattern),
            ),
        )
        if not allow_restricted:
            entity_statement = entity_statement.where(
                Entity.sensitivity != "restricted",
                Entity.handling_policy != "company_restricted",
            )
        entities = list(
            session.scalars(entity_statement.order_by(Entity.updated_at.desc()).limit(remaining))
        )

    return _merge_ranked_results(
        records,
        entities,
        normalized=normalized,
        tokens=tokens,
        strategy="fts_or_substring",
        limit=limit,
    )


def _merge_ranked_results(
    records: list[Record],
    entities: list[Entity],
    *,
    normalized: str,
    tokens: tuple[str, ...],
    strategy: str,
    limit: int,
) -> list[SearchResult]:
    ranked: list[tuple[float, Any, SearchResult]] = []
    for record in records:
        score, matched_fields, matched_terms, exact_primary = _search_diagnostics(
            (
                ("title", record.title, 12),
                ("summary", record.summary, 5),
                ("body_markdown", record.body_markdown, 2),
                ("payload", _payload_text(record.payload), 1),
            ),
            normalized,
            tokens,
        )
        ranked.append(
            (
                score,
                record.updated_at,
                SearchResult(
                    result_type="record",
                    id=record.id,
                    title=record.title,
                    summary=record.summary,
                    domain=record.domain,
                    kind=record.kind,
                    sensitivity=record.sensitivity,
                    updated_at=record.updated_at,
                    score=float(score),
                    matched_fields=matched_fields,
                    matched_terms=matched_terms,
                    query_strategy="exact_title" if exact_primary else strategy,
                    normalized_query=normalized,
                ),
            )
        )
    for entity in entities:
        score, matched_fields, matched_terms, exact_primary = _search_diagnostics(
            (
                ("name", entity.name, 12),
                ("canonical_name", entity.canonical_name, 5),
                ("description", entity.description, 2),
                ("aliases", _payload_text(entity.payload), 1),
            ),
            normalized,
            tokens,
        )
        ranked.append(
            (
                score,
                entity.updated_at,
                SearchResult(
                    result_type="entity",
                    id=entity.id,
                    title=entity.name,
                    summary=entity.description,
                    domain=None,
                    kind=entity.entity_type,
                    sensitivity=entity.sensitivity,
                    updated_at=entity.updated_at,
                    score=float(score),
                    matched_fields=matched_fields,
                    matched_terms=matched_terms,
                    query_strategy="exact_title" if exact_primary else strategy,
                    normalized_query=normalized,
                ),
            )
        )
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in ranked[:limit]]


def _search_diagnostics(
    fields: tuple[tuple[str, str | None, int], ...],
    normalized: str,
    tokens: tuple[str, ...],
) -> tuple[int, list[str], list[str], bool]:
    normalized_fields = tuple(
        (field_name, _normalize_field(field), weight) for field_name, field, weight in fields
    )
    matched_fields: list[str] = []
    matched_terms: list[str] = []
    score = 0
    for token in tokens:
        token_matched = False
        for field_name, field, weight in normalized_fields:
            if token in field:
                score += weight
                token_matched = True
                if field_name not in matched_fields:
                    matched_fields.append(field_name)
        if token_matched:
            matched_terms.append(token)
        if token in normalized_fields[0][1]:
            score += 20
    normalized_casefold = _normalize_field(normalized)
    for field_name, field, weight in normalized_fields:
        if normalized_casefold and normalized_casefold in field:
            score += weight * 4
            if field_name not in matched_fields:
                matched_fields.append(field_name)
    exact_primary = normalized_fields[0][1] == normalized_casefold
    if exact_primary:
        score += 100
    return score, matched_fields, matched_terms, exact_primary


def _normalize_query(query: str) -> str:
    normalized = unicodedata.normalize("NFKC", query).casefold().strip()
    if not normalized:
        return ""
    normalized = _QUERY_SEPARATORS.sub(" ", normalized)
    normalized = _QUERY_PREFIX.sub("", normalized)
    for phrase in _QUERY_PHRASES_TO_REMOVE:
        normalized = normalized.replace(phrase, " ")
    for connector in _QUERY_CONNECTORS:
        normalized = normalized.replace(connector, " ")
    return _QUERY_WHITESPACE.sub(" ", normalized).strip()


def _normalize_field(value: str | None) -> str:
    return unicodedata.normalize("NFKC", value or "").casefold()


def _payload_text(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _query_tokens(query: str) -> tuple[str, ...]:
    tokens: list[str] = []
    seen: set[str] = set()
    for raw_token in query.split():
        token = raw_token.casefold()
        if not token or token in _STOP_TOKENS or token in seen:
            continue
        tokens.append(token)
        seen.add(token)
        if len(tokens) >= MAX_QUERY_TOKENS:
            break
    return tuple(tokens)


def _fallback_tokens(tokens: tuple[str, ...]) -> tuple[str, ...]:
    informative = tuple(
        token
        for token in tokens
        if token not in _STOP_TOKENS and (len(token) >= 2 or not token.isascii())
    )
    return informative[:MAX_QUERY_TOKENS]


def _like_pattern(value: str) -> str:
    escaped = value.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _contains(
    field: InstrumentedAttribute[Any],
    pattern: str,
) -> ColumnElement[bool]:
    return func.lower(func.coalesce(field, "")).like(pattern, escape="\\")


def _weighted_token_score(
    fields: tuple[tuple[InstrumentedAttribute[Any], int], ...],
    normalized: str,
    tokens: tuple[str, ...],
) -> tuple[ColumnElement[int], ColumnElement[int]]:
    score: ColumnElement[int] = literal(0)
    match_count: ColumnElement[int] = literal(0)
    primary_field = fields[0][0]
    for token in tokens:
        pattern = _like_pattern(token)
        field_matches: list[ColumnElement[bool]] = []
        for field, weight in fields:
            matched = _contains(field, pattern)
            field_matches.append(matched)
            score = score + case((matched, weight), else_=0)
        token_matched = or_(*field_matches)
        match_count = match_count + case((token_matched, 1), else_=0)
        score = score + case((_contains(primary_field, pattern), 20), else_=0)

    full_pattern = _like_pattern(normalized)
    for field, weight in fields:
        score = score + case((_contains(field, full_pattern), weight * 4), else_=0)
    exact_primary = func.lower(func.coalesce(primary_field, "")) == normalized.casefold()
    score = score + case((exact_primary, 100), else_=0)
    return score, match_count


def _minimum_token_matches(tokens: tuple[str, ...]) -> int:
    return max(2, (len(tokens) * 3 + 4) // 5)


def _search_records_by_tokens(
    session: Session,
    normalized: str,
    tokens: tuple[str, ...],
    *,
    allow_restricted: bool,
    limit: int,
    minimum_matches: int,
    filters: SearchFilters,
) -> list[Record]:
    score, match_count = _weighted_token_score(
        (
            (Record.title, 12),
            (Record.summary, 5),
            (Record.body_markdown, 2),
            (Record.payload, 1),
        ),
        normalized,
        tokens,
    )
    statement = select(Record).where(
        Record.deleted_at.is_(None),
        Record.lifecycle_status != "superseded",
        *_record_filter_clauses(filters),
        match_count >= minimum_matches,
    )
    if not allow_restricted:
        statement = statement.where(
            Record.sensitivity != "restricted",
            Record.handling_policy != "company_restricted",
        )
    return list(
        session.scalars(statement.order_by(score.desc(), Record.updated_at.desc()).limit(limit))
    )


def _search_entities_by_tokens(
    session: Session,
    normalized: str,
    tokens: tuple[str, ...],
    *,
    allow_restricted: bool,
    limit: int,
    minimum_matches: int,
    filters: SearchFilters,
) -> list[Entity]:
    score, match_count = _weighted_token_score(
        (
            (Entity.name, 12),
            (Entity.canonical_name, 5),
            (Entity.description, 2),
            (Entity.payload, 1),
        ),
        normalized,
        tokens,
    )
    statement = select(Entity).where(
        Entity.deleted_at.is_(None),
        *_entity_filter_clauses(filters),
        match_count >= minimum_matches,
    )
    if not allow_restricted:
        statement = statement.where(
            Entity.sensitivity != "restricted",
            Entity.handling_policy != "company_restricted",
        )
    return list(
        session.scalars(statement.order_by(score.desc(), Entity.updated_at.desc()).limit(limit))
    )


def _search_records_fts(
    session: Session,
    query: str,
    *,
    allow_restricted: bool,
    limit: int,
    filters: SearchFilters,
) -> list[Record]:
    if len(query) < 3:
        return []
    quoted_query = f'"{query.replace(chr(34), chr(34) * 2)}"'
    privacy_clause = (
        ""
        if allow_restricted
        else "AND r.sensitivity != 'restricted' AND r.handling_policy != 'company_restricted'"
    )
    filter_clauses: list[str] = []
    parameters: dict[str, Any] = {"query": quoted_query, "limit": limit}
    if filters.domain is not None:
        filter_clauses.append("AND r.domain = :domain")
        parameters["domain"] = filters.domain
    if filters.schema_name is not None:
        filter_clauses.append("AND r.schema_name = :schema_name")
        parameters["schema_name"] = filters.schema_name
    if filters.kind is not None:
        filter_clauses.append("AND r.kind = :kind")
        parameters["kind"] = filters.kind
    if filters.sensitivity is not None:
        filter_clauses.append("AND r.sensitivity = :sensitivity")
        parameters["sensitivity"] = filters.sensitivity
    if filters.updated_after is not None:
        filter_clauses.append("AND r.updated_at >= :updated_after")
        parameters["updated_after"] = filters.updated_after
    if filters.updated_before is not None:
        filter_clauses.append("AND r.updated_at <= :updated_before")
        parameters["updated_before"] = filters.updated_before
    filter_sql = "\n".join(filter_clauses)
    statement = text(
        f"""
        SELECT r.id
        FROM records_fts
        JOIN records AS r ON r.rowid = records_fts.rowid
        WHERE records_fts MATCH :query
          AND r.deleted_at IS NULL
          AND r.lifecycle_status != 'superseded'
          {privacy_clause}
          {filter_sql}
        ORDER BY bm25(records_fts), r.updated_at DESC
        LIMIT :limit
        """
    )
    try:
        ids = list(session.scalars(statement, parameters))
    except OperationalError:
        session.rollback()
        return []
    if not ids:
        return []
    records_by_id = {
        record.id: record for record in session.scalars(select(Record).where(Record.id.in_(ids)))
    }
    return [records_by_id[record_id] for record_id in ids if record_id in records_by_id]


def _record_filter_clauses(filters: SearchFilters) -> tuple[ColumnElement[bool], ...]:
    clauses: list[ColumnElement[bool]] = []
    if filters.domain is not None:
        clauses.append(Record.domain == filters.domain)
    if filters.schema_name is not None:
        clauses.append(Record.schema_name == filters.schema_name)
    if filters.kind is not None:
        clauses.append(Record.kind == filters.kind)
    if filters.sensitivity is not None:
        clauses.append(Record.sensitivity == filters.sensitivity)
    if filters.updated_after is not None:
        clauses.append(Record.updated_at >= filters.updated_after)
    if filters.updated_before is not None:
        clauses.append(Record.updated_at <= filters.updated_before)
    return tuple(clauses)


def _entity_filter_clauses(filters: SearchFilters) -> tuple[ColumnElement[bool], ...]:
    clauses: list[ColumnElement[bool]] = []
    if filters.kind is not None:
        clauses.append(Entity.entity_type == filters.kind)
    if filters.sensitivity is not None:
        clauses.append(Entity.sensitivity == filters.sensitivity)
    if filters.updated_after is not None:
        clauses.append(Entity.updated_at >= filters.updated_after)
    if filters.updated_before is not None:
        clauses.append(Entity.updated_at <= filters.updated_before)
    return tuple(clauses)
