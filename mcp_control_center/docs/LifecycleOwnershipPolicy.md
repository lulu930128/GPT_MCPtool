# Component Lifecycle Ownership Policy

## Purpose

This policy defines the minimum process-ownership contract for every
`unified-lifecycle-v3` component. Control Center orchestrates fixed semantic
actions; each component remains the only owner of its process lifecycle and
runtime metadata.

## Evidence model

PID is a locator, not a stable process identity. A component must classify a
role from a single bounded evidence snapshot containing:

- PID file state and value;
- owner metadata state and parsed value;
- current process existence, executable path, command identity and start time;
- expected-port listener query state and all unique listener PIDs;
- managed-root to listener lineage when the listener may be a descendant;
- bounded service identity/readiness evidence when explicit adoption is allowed.

Evidence collection must complete before any PID or owner file is removed.

## Structured inspection states

Process inspection must distinguish:

- `PresentMatch`: the current process instance matches complete owner evidence;
- `PresentMismatch`: available evidence positively proves a different process instance;
- `MissingConfirmed`: the PID is positively confirmed absent;
- `Unknown`: permissions, CIM/process queries or required identity fields are unavailable.

Listener inspection must distinguish:

- `KnownNone`;
- `KnownSingle`;
- `KnownMultiple`;
- `Unknown`.

`Unknown` is never equivalent to missing, foreign or stopped and must result in
`OwnershipUnknown` with `canMutate=false`.

## Classification rules

| Process evidence | Listener evidence | Result | Mutation |
| --- | --- | --- | --- |
| PresentMatch | owned self/descendant | `OwnedReady` | allowed |
| PresentMatch | KnownNone | `OwnedNotListening` | bounded owned recovery allowed |
| PresentMatch | unrelated/multiple | `OwnershipMismatch` | forbidden |
| PresentMismatch or MissingConfirmed | KnownNone | `Stopped` | guarded metadata cleanup allowed |
| PresentMismatch or MissingConfirmed | any listener | `OwnershipMismatch` | forbidden; preserve evidence |
| any | Unknown | `OwnershipUnknown` | forbidden |
| Unknown | any | `OwnershipUnknown` | forbidden |
| no managed PID | KnownNone | `Stopped` | start allowed |
| no managed PID | any listener | `OwnershipMismatch` | forbidden unless explicit exact adoption passes |

A live process with missing, malformed or unreadable owner metadata is not
positive proof of PID reuse. It remains ownership-unknown unless an existing,
explicit adoption or orphan-recovery policy proves exact executable, command,
instance, lineage and service identity without weakening fail-closed behavior.

## Runtime metadata

Owner metadata uses atomic writes and contains at least:

```json
{
  "schemaVersion": 1,
  "role": "server",
  "pid": 12345,
  "executablePath": "C:\\path\\runtime.exe",
  "startTimeUtc": "2026-08-30T00:00:00.0000000Z",
  "identity": "component-role-identity",
  "recordedAt": "2026-08-30T00:00:00.0000000Z"
}
```

PID and owner metadata form one ownership pair. Cleanup must compare the
expected PID and expected owner instance (`role`, `pid`, start time and
identity) immediately before deletion. If either file was replaced by a newer
instance, cleanup must leave the new evidence untouched.

## Safety rules

- Never stop a process merely because its PID appears in a stale file.
- Never kill by process name or take over an occupied port.
- A foreign or multiple listener always fails closed.
- Health `200` alone is insufficient for adoption.
- Bind the exact process instance to one opened native process handle before
  mutation; validate executable, start time, owner metadata and lineage against
  that bound instance, then terminate through the same handle.
- A fresh PID lookup followed by numeric-PID termination is not sufficient: if
  the instance cannot be bound or changes before mutation, return
  `OwnershipUnknown` or `OWNERSHIP_CHANGED` and preserve ownership evidence.
- For process trees, bind and validate the root and every live descendant before
  the first termination, then stop the already-bound instances deepest-first.
- Keep lifecycle actions serialized by the component mutex and bounded.
- Native tunnel PID writers are external writers for race analysis even when
  they normally write the same root PID as the controller.

## Required conformance tests

Each production component must use isolated temporary roots and fake children
to cover:

1. missing-process stale PID;
2. live unrelated reused PID with no listener;
3. same executable but wrong process instance;
4. stale PID plus foreign listener;
5. valid owned process without listener;
6. valid owned ready runtime and idempotent ensure;
7. repeated/mutex-conflicting lifecycle actions;
8. PID/owner cleanup compare-and-delete race;
9. process inspection unknown;
10. listener query unknown and multiple listeners;
11. missing/malformed/wrong-role owner metadata;
12. proof that no unrelated process is stopped.

Source and isolated conformance do not close the Windows cold-boot gate. A
production claim requires separately authorized Startup-authority inspection,
formal component adoption and an actual reboot acceptance with post-boot
ownership, listener, readiness and duplicate-process evidence.
