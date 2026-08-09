from __future__ import annotations

from typing import cast

from openai import OpenAI

from personal_asset_os.errors import ValidationError
from personal_asset_os.settings import Settings

READY_MARKER = "PAOS_OPENAI_READY"


def connection_status(settings: Settings) -> dict[str, object]:
    return {
        "configured": settings.openai_configured,
        "model": settings.openai_model,
        "policy": "manual-invocation-only; no ledger writes",
    }


def check_connection(settings: Settings) -> dict[str, object]:
    """Make one minimal model call without sending personal finance data."""
    if not settings.openai_configured or settings.openai_api_key is None:
        raise ValidationError("尚未設定 OPENAI_API_KEY")

    client = OpenAI(
        api_key=settings.openai_api_key.get_secret_value(),
        timeout=settings.openai_timeout_seconds,
        max_retries=1,
    )
    response = client.responses.create(
        model=settings.openai_model,
        instructions="Return only the exact readiness marker requested by the user.",
        input=f"Return exactly: {READY_MARKER}",
        reasoning={"effort": "low"},
        text={"verbosity": "low"},
        max_output_tokens=32,
        store=False,
    )
    output = response.output_text.strip()
    if READY_MARKER not in output:
        raise RuntimeError("OpenAI response did not contain the expected readiness marker")

    usage = response.usage
    return {
        "ok": True,
        "model_requested": settings.openai_model,
        "model_returned": response.model,
        "response_id": response.id,
        "input_tokens": cast(int | None, getattr(usage, "input_tokens", None)),
        "output_tokens": cast(int | None, getattr(usage, "output_tokens", None)),
        "personal_finance_data_sent": False,
    }
