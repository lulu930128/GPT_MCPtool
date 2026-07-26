# GPT Project Workspace MCP

This project is a local read-only MCP server for exposing bounded context from an explicit set of workspace roots.

## Safety Rules

- Keep the server read-only by default. Do not add write, delete, move, shell, commit, push, or database mutation tools without a separate security review.
- All filesystem access must go through `src/path-guard.ts`.
- Keep `WORKSPACE_MCP_ROOTS` as an explicit id-to-path allowlist. Preserve `WORKSPACE_MCP_ROOT` only as a legacy single-root fallback. Never allow arbitrary absolute paths or a whole system drive by implication.
- Keep root-specific exclusions, such as `data=private-folder`, enforced through the shared path guard.
- Deny secrets, local env files, VCS internals, caches, virtualenvs, dependency folders, local databases, archives, and model weights unless the user explicitly designs a narrower safe reader.
- Do not print logs to stdout in STDIO MCP mode. Use stderr only.

## Validation

- Run `npm run build` after code changes.
- Run `npm test` after changes to path guards, file readers, search, or tool schemas.
