# English Study Control Center integration

The component uses `unified-lifecycle-v3` and owns exactly two loopback roles:

1. English Study Hub at `127.0.0.1:8831`.
2. English Study MCP at `127.0.0.1:8830`.

Startup is Hub then MCP. Shutdown is MCP then Hub. PID files live in the
ignored component `.tmp` directory, and every stop/restart verifies executable,
command line, managed PID, and listener PID before acting. There is no
kill-by-name behavior.

The Control Center may read only health identity and ownership metadata. It
never reads the project-local SQLite database, study content, practice payload,
or credentials. The component is initially registered disabled and must not be
enabled or auto-started until isolated lifecycle and live MCP smoke pass.

V1 has no tunnel. External connector provisioning is intentionally separate
because it requires a private profile and DPAPI-protected key.

Validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runtime-control.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runtime-control.ps1 -Action Status
```
