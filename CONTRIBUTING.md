# Contributing

## Repository model

This monorepo contains independent components with separate dependencies, tests, MCP contracts,
data boundaries, and Windows lifecycle ownership. Do not flatten, rename, or merge component
directories for convenience.

Before changing a component, read:

1. root `README.md`, `SECURITY.md`, and this contribution guide;
2. the component's `README.md` and tracked design/contract documents;
3. non-empty tracked `docs/product/` documents, if present;
4. relevant manifest, tests, entrypoints, and lifecycle documentation.

Local Agent or Codex instruction files may exist in a contributor's checkout, but they are ignored
operator state rather than public product documentation and must not be force-added.

Public visibility does not itself grant reuse rights. This contribution guide describes repository
quality and safety expectations; it is not a software license.

## Change scope

- Keep diffs minimal and localized.
- Preserve public tool names, API shapes, paths, ports, launcher entrypoints, and error semantics
  unless a requested change explicitly includes a compatible migration.
- Do not copy domain logic into an adapter.
- Do not perform unrelated dependency upgrades, broad formatting, large rewrites, or cleanup.
- Treat an existing dirty worktree as user-owned. Never revert unrelated changes.
- Do not commit or push unless the repository owner explicitly requests it.

## Component boundaries

- `OMI_search` mechanically forwards the OMI public contract; market/freshness/decision logic stays
  in OMI.
- `japanese_study` uses the versioned Japanese Study Hub API; schema, persistence, imports, and
  domain rules stay in the Hub.
- `project_reading` remains read-only and all filesystem access uses the shared path guard.
- `Memory Core` formal writes go through API/application services and candidate review boundaries.
- `personal-asset-os` formal accounting truth is immutable `transactions + postings`.
- `codex_bridge` keeps project allowlisting, app-only approvals, and the local App Server boundary.
- `mcp_control_center` coordinates component-owned lifecycle/probes and must not become another MCP
  or domain-data store.

## Security and privacy

Never add:

- usable secrets, tokens, DPAPI content, tunnel profiles, private endpoints, or credentials;
- `.env`, `.secrets`, `.local`, logs, PIDs, caches, databases, backups, exports, personal data, or
  financial/study/memory/job content;
- `AGENTS.md`, `.agents`, `.codex`, remote attachments, agent-run notes, or other local AI-agent
  instruction/session state;
- virtualenvs, `node_modules`, build output, downloaded executables, or generated runtime state.

Examples must use unusable placeholders such as `tunnel_replace_me`. Screenshots and fixtures must
contain synthetic data and no private project, account, path, or identifier.

Do not use `git add -f` to bypass ignore rules.

## Documentation

- Use Traditional Chinese for user-facing repository documentation unless the existing component
  intentionally uses English.
- Keep code identifiers, tool names, environment variables, commands, and protocol fields exact.
- Describe only behavior proven by current source, tests, or an accepted product/contract document.
- Mark limitations, partial behavior, freshness, scope, and unimplemented work explicitly.
- Prefer a short README that links to focused `docs/` files over one continuously growing README.
- Do not link public docs to ignored `docs/agent-runs/` content. Promote durable decisions into a
  tracked design, ADR, contract, security, or operations document.
- After docs-only changes, run UTF-8 readback, local Markdown link checks, secret scans, and
  `git diff --check`; do not run unrelated builds/tests.

## Validation

Discover the current commands from each component manifest and README. Typical checks are:

```powershell
cd C:\GPT_MCPtool\project_reading
npm test

cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests

cd "C:\GPT_MCPtool\Memory Core"
uv run ruff check .
uv run pytest

cd C:\GPT_MCPtool\japanese_study
npm test

cd C:\GPT_MCPtool\codex_bridge
npm test
npm run smoke:http

cd C:\GPT_MCPtool\personal-asset-os
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1
```

Choose the smallest sufficient validation tier. Live tunnel, external API, write smoke, browser,
paid quota, Startup, migration, and destructive data operations are never default checks.

Bug fixes should explain root cause, why the fix preserves the component boundary, and which
regression proves it. If a check cannot run, state the exact reason and command still needed.

## Commit and pull request hygiene

Before staging:

1. run `git status --short --branch`;
2. identify user/unrelated changes and exclude them;
3. stage exact component paths, not an indiscriminate worktree;
4. inspect `git diff --cached --name-only` and `git diff --cached`;
5. scan for credentials, private data, runtime artifacts, and large files;
6. run `git diff --cached --check`.

Use concise Conventional Commit subjects when possible, for example:

- `docs(omi-search): document public contract diagnostics`
- `fix(project-reading): reject escaped asset paths`
- `test(memory-core): cover candidate review conflicts`

A pull request should summarize changed boundaries/files, verification actually performed, known
risks, and limitations. Do not claim tests passed unless they were run.

## External side effects

Opening a PR, pushing, publishing, installing Startup entries, rotating credentials, restarting
shared runtimes, calling paid APIs, or writing production data requires explicit authorization.
