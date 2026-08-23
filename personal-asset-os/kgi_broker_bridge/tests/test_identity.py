from __future__ import annotations

from kgi_broker_bridge.identity import AccountIdentityProjector


def test_account_identity_is_deterministic_masked_and_keyed() -> None:
    raw = "SYNTHETIC-ACCOUNT-0001"
    first = AccountIdentityProjector("a" * 32).project(raw)
    again = AccountIdentityProjector("a" * 32).project(raw)
    other_key = AccountIdentityProjector("b" * 32).project(raw)

    assert first == again
    assert first.opaque_id != other_key.opaque_id
    assert first.masked_label.endswith("0001")
    assert raw not in first.model_dump_json()
