# Personal Asset OS Mobile Sync

## Scope

The mobile path is Android-first, offline-first quick capture. It moves low-risk TWD
expense/income approval intents from a phone SQLite outbox to the desktop over USB/ADB loopback.

It is not a cloud relay. The phone never connects to SQLite or writes `transactions + postings`;
the desktop remains the validator and executor.

```text
phone SQLite outbox
  -> Expo SecureStore device token
  -> USB cable + adb reverse
  -> desktop loopback /api/mobile/*
  -> authenticate device + require one activity-fund account
  -> source=mobile_sync Financial Event + paired-mobile finalization
  -> formal ledger transaction (same database transaction)
```

## Pairing

The desktop creates a 12-character, single-use pairing code. Default validity is ten minutes; the
service accepts configured lifetimes only from one minute to one hour.

```powershell
uv run --frozen personal-asset-os mobile-pair
```

The phone submits the code, device id, and display name to `POST /api/mobile/pair`. On success:

- the desktop stores SHA-256 of the device token, never the raw token;
- the raw token is returned once;
- the phone stores it in Expo SecureStore/Android Keystore;
- re-pairing the same device rotates its token and clears revocation.

Pairing codes and device tokens must not be logged, committed, screenshotted, or sent through chat.

## USB/ADB transport

The desktop API uses `127.0.0.1:18876`. ADB reverse maps the phone's loopback port to the
desktop loopback listener:

```powershell
C:\work\bin\adb.cmd reverse tcp:18876 tcp:18876
C:\work\bin\adb.cmd reverse --list
```

For durable local use, PAOS can own an optional background bridge inside the server lifecycle. It
checks one explicitly configured device (or fails closed unless exactly one authorized device is
present), recreates the fixed reverse mapping after reconnect, and publishes only sanitized status.
It never stops the shared ADB daemon and does not make core readiness depend on a connected phone.

Configure the ignored local `.env` without printing the selected serial:

```powershell
.\.venv\Scripts\python.exe scripts\configure-mobile-usb-bridge.py `
  --adb-path C:\work\mobile-dev\android-sdk\platform-tools\adb.exe `
  --server-socket tcp:localhost:15037
```

`GET /api/mobile/transport` reports the optional bridge state without device identity. The phone
uses authenticated `GET /api/mobile/session` as a preflight and does not begin an outbox attempt or
POST a financial event until the desktop and unique activity-fund contract are reachable.

Cleartext HTTP is allowed only for `127.0.0.1`/`localhost` in this USB development path. Other HTTP
destinations remain blocked. The Secure MCP Tunnel does not carry mobile routes.

## Outbox record contract

Each event contains:

- schema version 3 for category-first direct activity-fund finalization;
- stable event id;
- event kind, occurred/captured time, amount, TWD currency, required `category_hint`, optional
  description, and optional legacy detail fields;
- `source=mobile_sync`;
- device id and monotonically assigned local sequence;
- idempotency key;
- SHA-256 of the canonical JSON payload.

The desktop recomputes the canonical hash and compares it in constant time. It also requires the
payload device id to match the authenticated Bearer token.

## Retry and conflict behavior

The pair `(device_id, local_sequence)` is unique.

- Same sequence, event id, idempotency key, payload hash, and source: return the existing Financial
  Event without duplication.
- Same sequence with different content: reject as a conflict.
- Same idempotency key with different event content: reject through the Financial Event idempotency
  contract.
- Network uncertainty: keep the outbox row and retry the same payload; do not assign a new event id
  merely because the response was lost.

The desktop records `last_seen_at` and the greatest accepted sequence for diagnostics. It does not
use the sequence to skip payload/hash validation.

## Single activity-fund boundary

`GET /api/mobile/session` reports `write_mode=single_activity_fund`, readiness, candidate count, and
the selected account only when exactly one eligible account exists. An eligible activity-fund
account is active, non-system, TWD, liquid, asset-kind, and either `cash` or `bank` subtype.

`POST /api/mobile/events` atomically captures the Financial Event and finalizes it against that
account. A successful response must contain the matching payload hash, `auto_finalized=true`, a
`matched` event with `approval_source=paired_mobile`, and its formal transaction ID. The phone does
not mark an outbox row synced unless all of those facts agree.

If there are zero or multiple eligible accounts, the desktop returns 503 and rolls back the whole
request. The phone keeps the row retryable; it never guesses an account and never stages a partial
success.

Schema v1 is retained as a compatibility-only staging path. An older installed App, or an existing
v1 outbox row opened after upgrade, receives the original `ingest_only=true` pending acknowledgement
and cannot create a formal transaction. Existing v2 rows retain their original canonical payload,
hash and direct-finalize behavior. Newly captured rows use v3, which requires `category_hint` and
allows an empty supplemental description. The desktop stores the category on the Financial Event and
uses it as the formal transaction description only when the optional description is empty.

The phone suggests bounded categories from its own successfully saved outbox history, separated by
expense/income kind, then fills the list with built-in defaults such as `吃飯` and `油費`. Merely typing
a value does not persist it; the custom category becomes selectable after the capture is committed to
phone SQLite. Category suggestions are local convenience state, not a second ledger truth source.

Mobile cannot:

- create or edit an Account;
- choose an arbitrary account, reverse, or adjust a transaction;
- write postings, trades, prices, observations, or snapshots;
- approve imports, month close, or AI proposals;
- access read-only MCP through the device token.

Desktop services remain the only validators/executors for ledger finalization. The paired token is
required, the payload device id must match it, and the Financial Event finalize service rejects a
`paired_mobile` source without the authenticated matching device identity.

## Device management

List non-secret device metadata:

```powershell
uv run --frozen personal-asset-os mobile-devices
```

Revoke one device:

```powershell
uv run --frozen personal-asset-os mobile-revoke <device-id>
```

Revocation is idempotent. A revoked token receives authentication failure and the phone must clear
it and pair again. Historical Financial Events and audit lineage remain; revocation is not data
deletion.

## Failure handling

| Symptom | Check | Safe action |
| --- | --- | --- |
| Phone cannot reach desktop | Server loopback health, USB authorization, `adb reverse --list` | Recreate exact port mapping; do not expose LAN/public API |
| Pairing code rejected | Expiry, prior use, transcription | Create a new one-time code locally |
| Token rejected | Revocation or token rotation | Clear phone token and pair again |
| Payload hash conflict | Canonical fields and phone implementation version | Keep row pending; do not edit hash to force acceptance |
| Device sequence conflict | Existing desktop event for same device/sequence | Compare ids and hash; never overwrite the accepted event |
| Activity-fund service unavailable | No eligible account or multiple candidates | Keep the phone row; configure exactly one activity-fund account on desktop and retry |

## Validation

Follow [mobile/README.md](../mobile/README.md) for build and device smoke steps. Acceptance includes
offline capture, process restart persistence, exact retry without duplication, balanced desktop
transaction creation, activity-fund balance movement, fail-closed account ambiguity, and token
rejection after revocation.
