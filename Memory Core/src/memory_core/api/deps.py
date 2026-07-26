from __future__ import annotations

from collections.abc import Callable, Generator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.models import ClientCredential
from memory_core.security import ClientPrincipal, hash_token


def get_session(request: Request) -> Generator[Session, None, None]:
    session_factory = request.app.state.database.session_factory
    with session_factory() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def get_current_client(
    session: SessionDep,
    token: Annotated[str | None, Header(alias="X-Memory-Core-Token")] = None,
) -> ClientPrincipal:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing client token",
            headers={"WWW-Authenticate": "MemoryCoreToken"},
        )
    credential = session.scalar(
        select(ClientCredential).where(
            ClientCredential.token_hash == hash_token(token),
            ClientCredential.enabled.is_(True),
        )
    )
    if credential is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid client token",
            headers={"WWW-Authenticate": "MemoryCoreToken"},
        )
    return ClientPrincipal(
        id=credential.id,
        name=credential.name,
        scopes=frozenset(credential.scopes),
    )


ClientDep = Annotated[ClientPrincipal, Depends(get_current_client)]


def require_scopes(*required_scopes: str) -> Callable[[ClientDep], ClientPrincipal]:
    def dependency(principal: ClientDep) -> ClientPrincipal:
        if not principal.require(*required_scopes):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"required_scopes": list(required_scopes)},
            )
        return principal

    return dependency


def get_request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


RequestIdDep = Annotated[str | None, Depends(get_request_id)]
