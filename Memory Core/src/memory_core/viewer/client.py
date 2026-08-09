from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

JsonObject = dict[str, Any]


class ViewerApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "backend_error",
        status_code: int | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.request_id = request_id

    def public_message(self) -> str:
        details = [self.code]
        if self.status_code is not None:
            details.append(f"HTTP {self.status_code}")
        if self.request_id:
            details.append(f"request {self.request_id}")
        return f"Memory Core 操作失敗（{', '.join(details)}）：{self.args[0]}"


class ViewerApiClient:
    """Synchronous loopback API client used only from the control-center worker pool."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        timeout_seconds: float = 8.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "Accept": "application/json",
                "User-Agent": "memory-core-control-center/0.2.0",
                "X-Memory-Core-Token": token,
            },
            timeout=timeout_seconds,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def health(self) -> JsonObject:
        return self._request_object("GET", "/health")

    def overview(self) -> JsonObject:
        return self._request_object("GET", "/api/v1/overview")

    def list_records(
        self,
        *,
        include_deleted: bool,
        limit: int = 100,
        offset: int = 0,
    ) -> list[JsonObject]:
        return self._request_list(
            "GET",
            "/api/v1/records",
            params={
                "include_deleted": str(include_deleted).lower(),
                "limit": limit,
                "offset": offset,
            },
        )

    def get_record(self, record_id: str, *, include_deleted: bool) -> JsonObject:
        return self._request_object(
            "GET",
            f"/api/v1/records/{record_id}",
            params={"include_deleted": str(include_deleted).lower()},
        )

    def create_record(self, content: JsonObject) -> JsonObject:
        created = self._request_object("POST", "/api/v1/records", json=content)
        return self._verify_record_write(created)

    def update_record(self, record_id: str, content: JsonObject) -> JsonObject:
        updated = self._request_object(
            "PATCH",
            f"/api/v1/records/{record_id}",
            json=content,
        )
        return self._verify_record_write(updated)

    def archive_record(
        self,
        record_id: str,
        *,
        expected_version: int,
        reason: str | None,
    ) -> JsonObject:
        archived = self._request_object(
            "DELETE",
            f"/api/v1/records/{record_id}",
            params={
                "expected_version": expected_version,
                "reason": reason,
            },
        )
        return self._verify_record_write(archived)

    def get_record_revision(self, record_id: str, revision_no: int) -> JsonObject:
        return self._request_object(
            "GET",
            f"/api/v1/records/{record_id}/revisions/{revision_no}",
        )

    def list_record_links(
        self,
        record_id: str,
        *,
        direction: str,
        include_removed: bool = False,
    ) -> list[JsonObject]:
        return self._request_list(
            "GET",
            f"/api/v1/records/{record_id}/links",
            params={
                "direction": direction,
                "include_removed": str(include_removed).lower(),
            },
        )

    def list_entities(
        self,
        *,
        include_deleted: bool,
        limit: int = 100,
        offset: int = 0,
    ) -> list[JsonObject]:
        return self._request_list(
            "GET",
            "/api/v1/entities",
            params={
                "include_deleted": str(include_deleted).lower(),
                "limit": limit,
                "offset": offset,
            },
        )

    def get_entity(self, entity_id: str, *, include_deleted: bool) -> JsonObject:
        return self._request_object(
            "GET",
            f"/api/v1/entities/{entity_id}",
            params={"include_deleted": str(include_deleted).lower()},
        )

    def create_entity(self, content: JsonObject) -> JsonObject:
        created = self._request_object("POST", "/api/v1/entities", json=content)
        return self._verify_entity_write(created)

    def update_entity(self, entity_id: str, content: JsonObject) -> JsonObject:
        updated = self._request_object(
            "PATCH",
            f"/api/v1/entities/{entity_id}",
            json=content,
        )
        return self._verify_entity_write(updated)

    def archive_entity(
        self,
        entity_id: str,
        *,
        expected_version: int,
        reason: str | None,
    ) -> JsonObject:
        archived = self._request_object(
            "DELETE",
            f"/api/v1/entities/{entity_id}",
            params={
                "expected_version": expected_version,
                "reason": reason,
            },
        )
        return self._verify_entity_write(archived)

    def candidate_stats(self) -> JsonObject:
        return self._request_object("GET", "/api/v1/candidates/stats")

    def list_candidates(
        self,
        *,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[JsonObject]:
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if status is not None:
            params["status"] = status
        return self._request_list("GET", "/api/v1/candidates", params=params)

    def get_candidate(self, candidate_id: str) -> JsonObject:
        return self._request_object("GET", f"/api/v1/candidates/{candidate_id}")

    def create_media_experience_batch(self, content: JsonObject) -> JsonObject:
        created = self._request_object(
            "POST",
            "/api/v1/candidates/batches/media-experiences",
            json=content,
        )
        candidate = created.get("candidate")
        if (
            not isinstance(candidate, dict)
            or candidate.get("candidate_kind") != "batch"
            or created.get("item_count") != len(content.get("items") or [])
        ):
            raise ViewerApiError(
                "Batch 建立後的回應格式不正確",
                code="write_verification_failed",
            )
        candidate_id = candidate.get("id")
        if not isinstance(candidate_id, str):
            raise ViewerApiError(
                "Batch 建立後缺少 candidate id",
                code="write_verification_failed",
            )
        verified = self.get_candidate_batch(candidate_id)
        if verified.get("batch_id") != created.get("batch_id") or verified.get(
            "plan_hash"
        ) != created.get("plan_hash"):
            raise ViewerApiError(
                "Batch 建立後讀回的 id/hash 不一致",
                code="write_verification_failed",
            )
        return verified

    def get_candidate_batch(self, candidate_id: str) -> JsonObject:
        return self._request_object("GET", f"/api/v1/candidates/{candidate_id}/batch")

    def list_candidate_batch_items(
        self,
        candidate_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
        execution_state: str | None = None,
        decision: str | None = None,
    ) -> JsonObject:
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if execution_state is not None:
            params["execution_state"] = execution_state
        if decision is not None:
            params["decision"] = decision
        return self._request_object(
            "GET",
            f"/api/v1/candidates/{candidate_id}/items",
            params=params,
        )

    def get_candidate_batch_item(self, candidate_id: str, item_id: str) -> JsonObject:
        return self._request_object(
            "GET",
            f"/api/v1/candidates/{candidate_id}/items/{item_id}",
        )

    def revise_media_experience_batch(
        self,
        candidate_id: str,
        content: JsonObject,
    ) -> JsonObject:
        revised = self._request_object(
            "PATCH",
            f"/api/v1/candidates/{candidate_id}/batch",
            json=content,
        )
        verified = self.get_candidate_batch(candidate_id)
        if verified.get("current_revision_no") != revised.get(
            "current_revision_no"
        ) or verified.get("plan_hash") != revised.get("plan_hash"):
            raise ViewerApiError(
                "Batch 修訂後讀回的 revision/hash 不一致",
                code="write_verification_failed",
            )
        return verified

    def list_collections(
        self,
        *,
        domain: str | None = None,
        limit: int = 100,
    ) -> list[JsonObject]:
        params: dict[str, str | int] = {"limit": limit}
        if domain is not None:
            params["domain"] = domain
        return self._request_list("GET", "/api/v1/collections", params=params)

    def get_collection(self, collection_key: str, *, limit: int = 500) -> JsonObject:
        return self._request_object(
            "GET",
            f"/api/v1/collections/{collection_key}",
            params={"limit": limit},
        )

    def prepare_candidate_review(
        self,
        candidate_id: str,
        *,
        expected_review_digest: str,
    ) -> JsonObject:
        return self._request_object(
            "POST",
            f"/api/v1/candidates/{candidate_id}/prepare-review",
            json={"expected_review_digest": expected_review_digest},
        )

    def approve_candidate(
        self,
        candidate_id: str,
        *,
        expected_review_digest: str,
        approval_challenge: str,
        idempotency_key: str,
        review_note: str | None,
    ) -> JsonObject:
        approved = self._request_object(
            "POST",
            f"/api/v1/candidates/{candidate_id}/apply",
            json={
                "expected_review_digest": expected_review_digest,
                "approval_challenge": approval_challenge,
                "idempotency_key": idempotency_key,
                "review_note": review_note,
            },
        )
        if approved.get("candidate_kind") == "batch":
            detail = self.get_candidate_batch(candidate_id)
            items = detail.get("items")
            if not isinstance(items, list):
                raise ViewerApiError(
                    "Batch 套用後讀回的 Item 格式不正確",
                    code="write_verification_failed",
                )
            execution_state = detail.get("execution_state")
            if execution_state not in {"applied", "partially_applied", "failed"}:
                raise ViewerApiError(
                    "Batch 套用尚未完成，請重新整理後確認執行狀態",
                    code="write_verification_incomplete",
                )
            if any(
                not isinstance(item, dict)
                or (item.get("execution_state") == "applied" and item.get("verified_at") is None)
                for item in items
            ):
                raise ViewerApiError(
                    "Batch 有已套用但尚未完成讀回驗證的 Item",
                    code="write_verification_incomplete",
                )
            if execution_state == "applied" and any(
                isinstance(item, dict) and item.get("execution_state") not in {"applied", "skipped"}
                for item in items
            ):
                raise ViewerApiError(
                    "Batch 狀態與逐筆執行結果不一致",
                    code="write_verification_failed",
                )
            return {**approved, "_batch": detail}
        self._verify_candidate_results(approved)
        return approved

    def reject_candidate(
        self,
        candidate_id: str,
        *,
        reason: str,
        expected_review_digest: str,
        approval_challenge: str,
        idempotency_key: str,
    ) -> JsonObject:
        rejected = self._request_object(
            "POST",
            f"/api/v1/candidates/{candidate_id}/reject",
            json={
                "reason": reason,
                "expected_review_digest": expected_review_digest,
                "approval_challenge": approval_challenge,
                "idempotency_key": idempotency_key,
            },
        )
        if rejected.get("status") != "rejected":
            raise ViewerApiError(
                "Candidate 拒絕後的狀態不正確",
                code="write_verification_failed",
            )
        return rejected

    def export_json(self) -> JsonObject:
        return self._request_object("POST", "/api/v1/admin/export")

    def backup_sqlite(self) -> JsonObject:
        return self._request_object("POST", "/api/v1/admin/backup")

    def search(
        self,
        query: str,
        *,
        limit: int = 100,
        filters: Mapping[str, str] | None = None,
    ) -> list[JsonObject]:
        params: dict[str, str | int] = {"q": query, "limit": limit}
        if filters:
            params.update(filters)
        return self._request_list("GET", "/api/v1/search", params=params)

    def _verify_record_write(self, response: JsonObject) -> JsonObject:
        record_id = response.get("id")
        version = response.get("version")
        if not isinstance(record_id, str) or not isinstance(version, int):
            raise ViewerApiError(
                "Record 寫入回應缺少 id/version",
                code="write_verification_failed",
            )
        verified = self.get_record(record_id, include_deleted=True)
        if verified.get("id") != record_id or verified.get("version") != version:
            raise ViewerApiError(
                "Record 寫入後讀回的 id/version 不一致",
                code="write_verification_failed",
            )
        return verified

    def _verify_entity_write(self, response: JsonObject) -> JsonObject:
        entity_id = response.get("id")
        version = response.get("version")
        if not isinstance(entity_id, str) or not isinstance(version, int):
            raise ViewerApiError(
                "Entity 寫入回應缺少 id/version",
                code="write_verification_failed",
            )
        verified = self.get_entity(entity_id, include_deleted=True)
        if verified.get("id") != entity_id or verified.get("version") != version:
            raise ViewerApiError(
                "Entity 寫入後讀回的 id/version 不一致",
                code="write_verification_failed",
            )
        return verified

    def _verify_candidate_results(self, candidate: JsonObject) -> None:
        results = candidate.get("results")
        if isinstance(results, list) and results:
            for result in results:
                if not isinstance(result, dict):
                    raise ViewerApiError(
                        "Candidate result 格式不正確",
                        code="write_verification_failed",
                    )
                self._verify_candidate_result(
                    result.get("result_type"),
                    result.get("result_id"),
                    result.get("result_version"),
                )
            return
        self._verify_candidate_result(
            candidate.get("target_type"),
            candidate.get("result_id"),
            candidate.get("result_version"),
        )

    def _verify_candidate_result(
        self,
        result_type: object,
        result_id: object,
        result_version: object,
    ) -> None:
        if (
            result_type not in {"record", "entity"}
            or not isinstance(result_id, str)
            or not isinstance(result_version, int)
        ):
            raise ViewerApiError(
                "Candidate 寫入結果缺少可讀回的 ref/version",
                code="write_verification_failed",
            )
        if result_type == "record":
            verified = self.get_record(result_id, include_deleted=True)
        else:
            verified = self.get_entity(result_id, include_deleted=True)
        if verified.get("id") != result_id or verified.get("version") != result_version:
            raise ViewerApiError(
                "Candidate 正式結果讀回的 id/version 不一致",
                code="write_verification_failed",
            )

    def _request_object(self, method: str, path: str, **kwargs: Any) -> JsonObject:
        payload = self._request(method, path, **kwargs)
        if not isinstance(payload, dict):
            raise ViewerApiError(
                "後端回傳的物件格式不正確",
                code="invalid_backend_response",
            )
        return payload

    def _request_list(self, method: str, path: str, **kwargs: Any) -> list[JsonObject]:
        payload = self._request(method, path, **kwargs)
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise ViewerApiError(
                "後端回傳的清單格式不正確",
                code="invalid_backend_response",
            )
        return payload

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ViewerApiError("後端回應逾時", code="backend_timeout") from exc
        except httpx.RequestError as exc:
            raise ViewerApiError("無法連線到本機後端", code="backend_unavailable") from exc

        if response.is_success:
            try:
                return response.json()
            except ValueError as exc:
                raise ViewerApiError(
                    "後端回傳非 JSON 內容",
                    code="invalid_backend_response",
                    status_code=response.status_code,
                    request_id=response.headers.get("X-Request-ID"),
                ) from exc

        code = "backend_error"
        message = "後端拒絕這次操作"
        request_id = response.headers.get("X-Request-ID")
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            embedded_request_id = payload.get("request_id")
            if isinstance(embedded_request_id, str) and embedded_request_id:
                request_id = embedded_request_id[:64]
            error = payload.get("error")
            if isinstance(error, dict):
                error_code = error.get("code")
                error_message = error.get("message")
                if isinstance(error_code, str) and error_code:
                    code = error_code[:80]
                if isinstance(error_message, str) and error_message:
                    message = error_message[:500]
            else:
                detail = payload.get("detail")
                if isinstance(detail, str) and detail:
                    message = detail[:500]
        raise ViewerApiError(
            message,
            code=code,
            status_code=response.status_code,
            request_id=request_id,
        )
