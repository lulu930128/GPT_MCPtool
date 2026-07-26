from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from memory_core.models import AuditEvent
from memory_core.security import ClientPrincipal


def add_audit_event(
    session: Session,
    principal: ClientPrincipal | None,
    *,
    action: str,
    outcome: str,
    request_id: str | None,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        client_id=principal.id if principal else None,
        action=action,
        target_type=target_type,
        target_id=target_id,
        outcome=outcome,
        request_id=request_id,
        details=details or {},
    )
    session.add(event)
    session.flush()
    return event
