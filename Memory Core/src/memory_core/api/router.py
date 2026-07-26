from fastapi import APIRouter

from memory_core.api.routes import (
    admin,
    candidates,
    duplicates,
    entities,
    overview,
    records,
    search,
    tags,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(records.router)
api_router.include_router(entities.router)
api_router.include_router(tags.router)
api_router.include_router(candidates.router)
api_router.include_router(overview.router)
api_router.include_router(duplicates.router)
api_router.include_router(search.router)
api_router.include_router(admin.router)
