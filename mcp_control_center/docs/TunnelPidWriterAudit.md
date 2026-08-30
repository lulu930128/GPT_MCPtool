# Tunnel PID Writer Audit

Date: 2026-08-30

## Scope and classification

This source audit covers the seven production components registered with MCP Control Center. It is not evidence that a particular live Windows process or Startup shortcut is current.

The shared pattern is:

1. the component controller starts the exact tunnel-client executable;
2. `tunnel-client run` receives `--pid.file` for the component-local runtime path; and
3. the component controller also records the PID returned by process creation, then writes or validates the component-owned owner sidecar.

This is a double writer for the PID locator. It remains a P2 architecture debt, not a confirmed cause of the stale/reused PID defect.

## Findings

| Component | Native `--pid.file` | Controller PID write | Owner sidecar | Current conclusion |
| --- | --- | --- | --- | --- |
| Project Reading | yes | yes | yes | Same created tunnel root in isolated lifecycle tests. |
| OMI Search | yes | yes | yes | Same created tunnel root in isolated lifecycle tests. |
| Japanese Study | yes | yes, through owner-metadata write | yes | Same created tunnel root in isolated lifecycle tests. |
| Memory Core | yes | yes | existing ownership evidence | Existing reused-PID regression remains the baseline. |
| Codex Bridge | yes | yes | yes | Existing reused-PID regression remains the baseline. |
| Personal Asset OS | yes | yes, through owner-metadata write | yes | Same created tunnel root in isolated lifecycle tests. |
| English Study | yes in the production default | yes, through owner-metadata write | yes | Same created tunnel root contract; isolated tests may inject a fake tunnel argument. |

Manual tunnel and legacy tray scripts also pass component-local `--pid.file` paths. They are separate lifecycle entrypoints and must not be treated as concurrent writers authorized by Control Center. Windows Startup authority is checked separately by `startup.ps1 -Action Plan`.

## Correctness decision

No reviewed controller intentionally writes a wrapper PID while the native client writes a different listener PID. The controller records the PID returned for the exact tunnel-client process, and listener ownership must still match that root or its verified lineage before mutation.

The P1 fix therefore keeps the existing PID paths. Changing all tunnel PID paths would also require coordinated descriptor, manual-script, tray, startup and test migration and is not necessary to make listener-free PID reuse safe.

The retained double writer is acceptable only with these guards:

- PID is treated as a locator, not identity.
- Owner metadata binds PID, executable, start time, role and command identity.
- A foreign listener fails closed.
- Cleanup compares the previously collected PID and owner snapshots before deleting either file.
- No controller stops a process based only on the PID-file value.

## Follow-up gate

Split the files into a native PID locator and a controller-canonical ownership record only if live or isolated evidence shows a wrapper/root mismatch, a race overwrite with different PID values, or incompatible cleanup ownership. Any split must migrate all component controllers, tray/manual launchers, descriptors and tests together.
