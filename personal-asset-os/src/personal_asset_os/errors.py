from __future__ import annotations


class PersonalAssetError(Exception):
    """Base exception for predictable product errors."""

    code = "PERSONAL_ASSET_ERROR"
    status_code = 400

    def __init__(self, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class AuthenticationError(PersonalAssetError):
    code = "AUTHENTICATION_ERROR"
    status_code = 401


class ValidationError(PersonalAssetError):
    code = "VALIDATION_ERROR"
    status_code = 422


class NotFoundError(PersonalAssetError):
    code = "NOT_FOUND"
    status_code = 404


class ConflictError(PersonalAssetError):
    code = "CONFLICT"
    status_code = 409


class DataIntegrityError(PersonalAssetError):
    code = "DATA_INTEGRITY_ERROR"
    status_code = 409


class UnsafeOperationError(PersonalAssetError):
    code = "UNSAFE_OPERATION"
    status_code = 409
