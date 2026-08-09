# GPT Project Workspace MCP

This project is a local read-only MCP server for exposing bounded context from an explicit set of workspace roots.

## Safety Rules

- Keep the server read-only by default. Do not add write, delete, move, shell, commit, push, or database mutation tools without a separate security review.
- All filesystem access must go through `src/path-guard.ts`.
- Keep `WORKSPACE_MCP_ROOTS` as an explicit id-to-path allowlist. Preserve `WORKSPACE_MCP_ROOT` only as a legacy single-root fallback. Never allow arbitrary absolute paths or a whole system drive by implication.
- Keep root-specific exclusions, such as `data=private-folder`, enforced through the shared path guard.
- Deny secrets, local env files, VCS internals, caches, virtualenvs, dependency folders, local databases, archives, and model weights unless the user explicitly designs a narrower safe reader.
- Do not print logs to stdout in STDIO MCP mode. Use stderr only.

## Windows lifecycle

- `scripts/runtime-control.ps1` is the only lifecycle owner for the HTTP server and tunnel in `unified-lifecycle-v3` mode. Keep its actions fixed, serialized by the component mutex, and bounded.
- Process mutation requires listener PID plus exact executable and component-owned PID/start-time metadata. A foreign listener or stale/reused PID must fail closed; never replace by process name.
- `RepairConnectivity` must not restart a healthy core. `RestartCore` must not replace the tunnel. `ShutdownRuntime` must preflight both roles before stopping either one.
- `scripts/tray.ps1` is a UI adapter. It may invoke the controller but must not retain server/tunnel process handles or duplicate lifecycle logic.
- Keep the existing legacy tray launchers as rollback entrypoints until the control-center cold-boot acceptance is complete.

## Validation

- Run `npm run build` after code changes.
- Run `npm test` after changes to path guards, file readers, search, or tool schemas.
- Run `npm run runtime:test`, `npm run runtime:selftest`, and `npm run tray:selftest` after lifecycle changes.
