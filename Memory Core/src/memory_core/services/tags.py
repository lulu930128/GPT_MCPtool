from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.models import Tag
from memory_core.schemas import TagCreate
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event


def create_tag(
    session: Session,
    principal: ClientPrincipal,
    payload: TagCreate,
    *,
    request_id: str | None,
) -> Tag:
    normalized_name = payload.name.strip()
    existing = session.scalar(select(Tag).where(Tag.name == normalized_name))
    if existing:
        return existing
    tag = Tag(name=normalized_name, category=payload.category)
    session.add(tag)
    session.flush()
    add_audit_event(
        session,
        principal,
        action="tag.create",
        outcome="success",
        request_id=request_id,
        target_type="tag",
        target_id=tag.id,
    )
    return tag


def list_tags(session: Session, *, limit: int = 100, offset: int = 0) -> list[Tag]:
    statement = select(Tag).order_by(Tag.name).offset(offset).limit(limit)
    return list(session.scalars(statement))
