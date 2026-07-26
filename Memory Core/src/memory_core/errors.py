from __future__ import annotations


class DomainError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class NotFoundError(DomainError):
    def __init__(self, resource: str) -> None:
        super().__init__(404, "not_found", f"{resource} was not found")


class VersionConflictError(DomainError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            409,
            "version_conflict",
            f"Expected version {expected}, but current version is {actual}",
        )


class CandidateConflictError(DomainError):
    def __init__(self, message: str) -> None:
        super().__init__(409, "candidate_conflict", message)


class CandidateExpiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(410, "candidate_expired", "The candidate has expired")


class CandidateDigestMismatchError(DomainError):
    def __init__(self) -> None:
        super().__init__(
            409,
            "candidate_digest_mismatch",
            "The candidate no longer matches the content that was reviewed",
        )


class ReviewChallengeError(DomainError):
    def __init__(self, message: str = "The review challenge is invalid") -> None:
        super().__init__(409, "invalid_review_challenge", message)


class ReviewChallengeExpiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(410, "review_challenge_expired", "The review challenge has expired")


class OperationError(DomainError):
    def __init__(self, message: str) -> None:
        super().__init__(422, "invalid_operation", message)


class AuthorizationError(DomainError):
    def __init__(self, message: str = "The client does not have the required scope") -> None:
        super().__init__(403, "forbidden", message)
