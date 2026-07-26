from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.operations import create_json_export, create_sqlite_backup
from memory_core.schemas import OperationResult

router = APIRouter(prefix="/admin", tags=["admin"])

ExportAdmin = Annotated[ClientDep, Depends(require_scopes("admin:export"))]
BackupAdmin = Annotated[ClientDep, Depends(require_scopes("admin:backup"))]


@router.post("/export", response_model=OperationResult, status_code=status.HTTP_201_CREATED)
def export_json(
    request: Request,
    session: SessionDep,
    principal: ExportAdmin,
    request_id: RequestIdDep,
) -> OperationResult:
    manifest = create_json_export(
        session,
        request.app.state.settings,
        principal,
        request_id=request_id,
    )
    session.commit()
    return OperationResult.model_validate(manifest)


@router.post("/backup", response_model=OperationResult, status_code=status.HTTP_201_CREATED)
def backup_sqlite(
    request: Request,
    session: SessionDep,
    principal: BackupAdmin,
    request_id: RequestIdDep,
) -> OperationResult:
    manifest = create_sqlite_backup(
        session,
        request.app.state.settings,
        principal,
        request_id=request_id,
    )
    session.commit()
    return OperationResult.model_validate(manifest)
