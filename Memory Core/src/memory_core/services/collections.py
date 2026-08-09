from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import AuthorizationError, NotFoundError
from memory_core.models import (
    CollectionMember,
    MemoryCollection,
    Record,
    Revision,
)
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event


def _snapshot(collection: MemoryCollection) -> dict[str, Any]:
    return {
        "id": collection.id,
        "key": collection.key,
        "name": collection.name,
        "description": collection.description,
        "domain": collection.domain,
        "lifecycle_status": collection.lifecycle_status,
        "version": collection.version,
        "deleted_at": collection.deleted_at.isoformat() if collection.deleted_at else None,
    }


def get_collection_by_key(
    session: Session,
    key: str,
    *,
    include_deleted: bool = False,
) -> MemoryCollection:
    statement = select(MemoryCollection).where(MemoryCollection.key == key)
    if not include_deleted:
        statement = statement.where(MemoryCollection.deleted_at.is_(None))
    collection = session.scalar(statement)
    if collection is None:
        raise NotFoundError("collection")
    return collection


def list_collections(
    session: Session,
    *,
    allow_restricted: bool,
    domain: str | None = None,
    include_deleted: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> list[tuple[MemoryCollection, int]]:
    statement = select(MemoryCollection)
    if domain is not None:
        statement = statement.where(MemoryCollection.domain == domain)
    if not include_deleted:
        statement = statement.where(MemoryCollection.deleted_at.is_(None))
    statement = statement.order_by(MemoryCollection.name.asc()).offset(offset).limit(limit)
    collections = list(session.scalars(statement))
    results: list[tuple[MemoryCollection, int]] = []
    for collection in collections:
        count_statement = (
            select(func.count(CollectionMember.record_id))
            .join(Record, Record.id == CollectionMember.record_id)
            .where(
                CollectionMember.collection_id == collection.id,
                Record.deleted_at.is_(None),
            )
        )
        if not allow_restricted:
            count_statement = count_statement.where(
                Record.sensitivity != "restricted",
                Record.handling_policy != "company_restricted",
            )
        results.append((collection, int(session.scalar(count_statement) or 0)))
    return results


def list_collection_records(
    session: Session,
    key: str,
    *,
    allow_restricted: bool,
    limit: int = 100,
    offset: int = 0,
) -> tuple[MemoryCollection, int, list[tuple[CollectionMember, Record]]]:
    collection = get_collection_by_key(session, key)
    visible_statement = (
        select(CollectionMember, Record)
        .join(Record, Record.id == CollectionMember.record_id)
        .where(
            CollectionMember.collection_id == collection.id,
            Record.deleted_at.is_(None),
        )
    )
    if not allow_restricted:
        visible_statement = visible_statement.where(
            Record.sensitivity != "restricted",
            Record.handling_policy != "company_restricted",
        )
    total = int(session.scalar(select(func.count()).select_from(visible_statement.subquery())) or 0)
    statement = visible_statement.order_by(
        CollectionMember.position.asc().nullslast(),
        CollectionMember.created_at.asc(),
    )
    statement = statement.offset(offset).limit(limit)
    return collection, total, list(session.execute(statement).tuples())


def get_or_create_collection(
    session: Session,
    principal: ClientPrincipal,
    *,
    key: str,
    name: str,
    domain: str | None,
    description: str | None,
    request_id: str | None,
) -> tuple[MemoryCollection, bool]:
    existing = session.scalar(select(MemoryCollection).where(MemoryCollection.key == key))
    if existing is not None:
        return existing, False
    collection = MemoryCollection(
        key=key,
        name=name,
        description=description,
        domain=domain,
        created_by_client_id=principal.id,
    )
    session.add(collection)
    session.flush()
    session.add(
        Revision(
            target_type="collection",
            target_id=collection.id,
            revision_no=1,
            old_data=None,
            new_data=_snapshot(collection),
            changed_by_client_id=principal.id,
            change_reason="created by batch projection",
        )
    )
    add_audit_event(
        session,
        principal,
        action="collection.create",
        outcome="success",
        request_id=request_id,
        target_type="collection",
        target_id=collection.id,
        details={"key": key},
    )
    session.flush()
    return collection, True


def upsert_collection_member(
    session: Session,
    principal: ClientPrincipal,
    *,
    collection_key: str,
    collection_name: str,
    domain: str | None,
    record_id: str,
    source_candidate_item_id: str | None,
    position: int | None,
    request_id: str | None,
) -> tuple[CollectionMember, bool]:
    record = session.get(Record, record_id)
    if record is None or record.deleted_at is not None:
        raise NotFoundError("record")
    if (
        record.sensitivity == "restricted" or record.handling_policy == "company_restricted"
    ) and not principal.has_scope("restricted:write"):
        raise AuthorizationError("restricted:write scope is required")
    collection, _created = get_or_create_collection(
        session,
        principal,
        key=collection_key,
        name=collection_name,
        domain=domain,
        description=None,
        request_id=request_id,
    )
    existing = session.get(
        CollectionMember,
        {"collection_id": collection.id, "record_id": record_id},
    )
    if existing is not None:
        changed = (
            existing.position != position
            or existing.source_candidate_item_id != source_candidate_item_id
        )
        if changed:
            existing.position = position
            existing.source_candidate_item_id = source_candidate_item_id
            existing.updated_at = utc_now()
            add_audit_event(
                session,
                principal,
                action="collection.member_update",
                outcome="success",
                request_id=request_id,
                target_type="collection",
                target_id=collection.id,
                details={"record_id": record_id},
            )
            session.flush()
        return existing, False
    member = CollectionMember(
        collection_id=collection.id,
        record_id=record_id,
        position=position,
        source_candidate_item_id=source_candidate_item_id,
    )
    session.add(member)
    add_audit_event(
        session,
        principal,
        action="collection.member_add",
        outcome="success",
        request_id=request_id,
        target_type="collection",
        target_id=collection.id,
        details={"record_id": record_id},
    )
    session.flush()
    return member, True
