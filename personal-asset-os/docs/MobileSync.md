# Personal Asset OS Mobile Sync

## Scope

The v0.1 mobile path is Android-first, offline-first quick capture. It moves TWD expense/income
events from a phone SQLite outbox to the desktop Financial Event staging area over USB/ADB
loopback.

It is not a cloud relay and it never writes `transactions + postings` directly.

```text
phone SQLite outbox
  -> Expo SecureStore device token
  -> USB cable + adb reverse
  -> desktop loopback /api/mobile/*
  -> source=mobile_sync Financial Event
  -> desktop review/finalize
  -> formal ledger transaction
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

The desktop API remains on `127.0.0.1:8876`. ADB reverse maps the phone's loopback port to the
desktop loopback listener:

```powershell
C:\work\bin\adb.cmd reverse tcp:8876 tcp:8876
C:\work\bin\adb.cmd reverse --list
```

Cleartext HTTP is allowed only for `127.0.0.1`/`localhost` in this USB development path. Other HTTP
destinations remain blocked. The Secure MCP Tunnel does not carry mobile routes.

## Outbox record contract

Each event contains:

- schema version 1;
- stable event id;
- event kind, occurred/captured time, amount, TWD currency, description, and optional fields;
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

## Ingest-only boundary

`GET /api/mobile/session` explicitly reports `ingest_only=true`. `POST /api/mobile/events` creates
or returns a pending Financial Event and also reports `ingest_only=true`.

Mobile cannot:

- create or edit an Account;
- finalize, reverse, or adjust a transaction;
- write postings, trades, prices, observations, or snapshots;
- approve imports, month close, or AI proposals;
- access read-only MCP through the device token.

Desktop services remain the only validators/executors for ledger finalization.

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
| Event synced but absent from net worth | It is staging by design | Review/finalize it in the trusted desktop UI |

## Validation

Follow [mobile/README.md](../mobile/README.md) for build and device smoke steps. Acceptance includes
offline capture, process restart persistence, exact retry without duplication, desktop pending
event appearance, and token rejection after revocation.
