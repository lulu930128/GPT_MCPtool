from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx
from pydantic import SecretStr

from memory_core.mcp.settings import McpSettings


class MemoryCoreApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str = "backend_error",
        request_id: str | None = None,
        field: str | None = None,
        received_value: str | int | float | bool | None = None,
        example: str | int | float | bool | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.field = field
        self.received_value = received_value
        self.example = example

    def public_message(self) -> str:
        details = [self.code]
        if self.status_code is not None:
            details.append(f"HTTP {self.status_code}")
        if self.request_id:
            details.append(f"request {self.request_id}")
        message = f"Memory Core request failed ({', '.join(details)}): {self.args[0]}"
        if self.field:
            message = f"{message} [field: {self.field}]"
        return message


class MemoryCoreApiClient:
    def __init__(
        self,
        settings: McpSettings,
        *,
        client_token: SecretStr | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        resolved_token = client_token or settings.client_token
        self._api_base_url = settings.api_base_url
        self._client = httpx.AsyncClient(
            base_url=f"{settings.api_base_url}/api/v1",
            headers={
                "Accept": "application/json",
                "User-Agent": "memory-core-mcp/0.2.0",
                "X-Memory-Core-Token": resolved_token.get_secret_value(),
            },
            timeout=settings.api_timeout_seconds,
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def health(self) -> bool:
        try:
            response = await self._client.get(f"{self._api_base_url}/health")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return False
        return isinstance(payload, dict) and payload.get("status") == "ok"

    async def search(
        self,
        query: str,
        limit: int,
        *,
        filters: Mapping[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str | int] = {"q": query, "limit": limit}
        if filters:
            params.update(filters)
        payload = await self._request("GET", "/search", params=params)
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise MemoryCoreApiError(
                "Backend returned an invalid search response",
                code="invalid_backend_response",
            )
        return payload

    async def get_record(
        self,
        record_id: str,
        *,
        include_deleted: bool = False,
    ) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            f"/records/{record_id}",
            params={"include_deleted": str(include_deleted).lower()},
        )

    async def get_record_revision(
        self,
        record_id: str,
        revision_no: int,
    ) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            f"/records/{record_id}/revisions/{revision_no}",
        )

    async def list_record_links(
        self,
        record_id: str,
        *,
        direction: str,
        include_removed: bool,
    ) -> list[dict[str, Any]]:
        payload = await self._request(
            "GET",
            f"/records/{record_id}/links",
            params={
                "direction": direction,
                "include_removed": str(include_removed).lower(),
            },
        )
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise MemoryCoreApiError(
                "Backend returned an invalid Record Link list",
                code="invalid_backend_response",
            )
        return payload

    async def get_entity(
        self,
        entity_id: str,
        *,
        include_deleted: bool = False,
    ) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            f"/entities/{entity_id}",
            params={"include_deleted": str(include_deleted).lower()},
        )

    async def overview(self) -> dict[str, Any]:
        return await self._request_object("GET", "/overview")

    async def detect_duplicates(self, limit: int) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            "/duplicates",
            params={"limit": limit},
        )

    async def create_candidate(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return await self._request_object("POST", "/candidates", json=dict(payload))

    async def create_change_set(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return await self._request_object(
            "POST",
            "/candidates/change-sets",
            json=dict(payload),
        )

    async def create_media_experience_batch(
        self,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        return await self._request_object(
            "POST",
            "/candidates/batches/media-experiences",
            json=dict(payload),
        )

    async def get_candidate_batch(self, candidate_id: str) -> dict[str, Any]:
        return await self._request_object("GET", f"/candidates/{candidate_id}/batch")

    async def list_candidate_batch_items(
        self,
        candidate_id: str,
        *,
        limit: int = 20,
        offset: int = 0,
        execution_state: str | None = None,
        decision: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if execution_state is not None:
            params["execution_state"] = execution_state
        if decision is not None:
            params["decision"] = decision
        return await self._request_object(
            "GET",
            f"/candidates/{candidate_id}/items",
            params=params,
        )

    async def get_candidate_batch_item(
        self,
        candidate_id: str,
        item_id: str,
    ) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            f"/candidates/{candidate_id}/items/{item_id}",
        )

    async def list_collections(
        self,
        *,
        domain: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        params: dict[str, str | int] = {"limit": limit}
        if domain is not None:
            params["domain"] = domain
        payload = await self._request("GET", "/collections", params=params)
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise MemoryCoreApiError(
                "Backend returned an invalid collection list",
                code="invalid_backend_response",
            )
        return payload

    async def get_collection(
        self,
        collection_key: str,
        *,
        limit: int = 100,
    ) -> dict[str, Any]:
        return await self._request_object(
            "GET",
            f"/collections/{collection_key}",
            params={"limit": limit},
        )

    async def list_candidates(
        self,
        *,
        status: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        params: dict[str, str | int] = {"limit": limit}
        if status:
            params["status"] = status
        payload = await self._request("GET", "/candidates", params=params)
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise MemoryCoreApiError(
                "Backend returned an invalid candidate list",
                code="invalid_backend_response",
            )
        return payload

    async def get_candidate(self, candidate_id: str) -> dict[str, Any]:
        return await self._request_object("GET", f"/candidates/{candidate_id}")

    async def candidate_stats(self) -> dict[str, Any]:
        return await self._request_object("GET", "/candidates/stats")

    async def prepare_candidate_review(
        self,
        candidate_id: str,
        *,
        expected_review_digest: str,
    ) -> dict[str, Any]:
        return await self._request_object(
            "POST",
            f"/candidates/{candidate_id}/prepare-review",
            json={"expected_review_digest": expected_review_digest},
        )

    async def approve_candidate(
        self,
        candidate_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        return await self._request_object(
            "POST",
            f"/candidates/{candidate_id}/apply",
            json=dict(payload),
        )

    async def reject_candidate(
        self,
        candidate_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        return await self._request_object(
            "POST",
            f"/candidates/{candidate_id}/reject",
            json=dict(payload),
        )

    async def _request_object(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        payload = await self._request(method, path, **kwargs)
        if not isinstance(payload, dict):
            raise MemoryCoreApiError(
                "Backend returned an invalid object response",
                code="invalid_backend_response",
            )
        return payload

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise MemoryCoreApiError("Backend request timed out", code="backend_timeout") from exc
        except httpx.RequestError as exc:
            raise MemoryCoreApiError("Backend is unavailable", code="backend_unavailable") from exc

        if response.is_success:
            try:
                return response.json()
            except ValueError as exc:
                raise MemoryCoreApiError(
                    "Backend returned non-JSON content",
                    status_code=response.status_code,
                    code="invalid_backend_response",
                    request_id=response.headers.get("X-Request-ID"),
                ) from exc

        code, message, request_id, field, received_value, example = self._parse_error(response)
        raise MemoryCoreApiError(
            message,
            status_code=response.status_code,
            code=code,
            request_id=request_id,
            field=field,
            received_value=received_value,
            example=example,
        )

    @staticmethod
    def _parse_error(
        response: httpx.Response,
    ) -> tuple[
        str,
        str,
        str | None,
        str | None,
        str | int | float | bool | None,
        str | int | float | bool | None,
    ]:
        code = "backend_error"
        message = "The backend rejected the request"
        request_id = response.headers.get("X-Request-ID")
        field: str | None = None
        received_value: str | int | float | bool | None = None
        example: str | int | float | bool | None = None
        try:
            payload = response.json()
        except ValueError:
            return code, message, request_id, field, received_value, example
        if not isinstance(payload, dict):
            return code, message, request_id, field, received_value, example
        embedded_request_id = payload.get("request_id")
        if isinstance(embedded_request_id, str) and embedded_request_id:
            request_id = embedded_request_id[:64]
        error = payload.get("error")
        if isinstance(error, dict):
            error_code = error.get("code")
            error_message = error.get("message")
            error_field = error.get("field")
            error_received_value = error.get("received_value")
            error_example = error.get("example")
            if isinstance(error_code, str) and error_code:
                code = error_code[:80]
            if isinstance(error_message, str) and error_message:
                message = error_message[:500]
            if isinstance(error_field, str) and error_field:
                field = error_field[:120]
            if isinstance(error_received_value, (str, int, float, bool)):
                received_value = error_received_value
            if isinstance(error_example, (str, int, float, bool)):
                example = error_example
        else:
            detail = payload.get("detail")
            if isinstance(detail, str) and detail:
                message = detail[:500]
        return code, message, request_id, field, received_value, example
