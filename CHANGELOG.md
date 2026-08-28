# Changelog

This file records user-visible, contract, security, operations, and repository-structure changes.
Workspace releases use one shared application/package SemVer. Protocol, schema, registry, and
domain-contract versions remain independent and are not rewritten by a workspace release.

## Unreleased

### Added

- English Study 0.3.0 adds three bounded reference-catalog tools, a component-owned desktop
  launcher, fixed local ports, and its own managed secure-tunnel lifecycle.
- Personal Asset OS adds read-time Taiwan and US broker valuation overlays, traceable FX fallback,
  immutable daily valuation snapshots, reporting annotations, and mobile activity-fund ingestion.
- Codex Bridge adds server-generated read-only pasted-text handoff copies for approved Codex jobs.
- Codex Bridge adds durable redacted multi-turn conversation projections, reconnectable progress,
  app-only local history reads, and explicit continuation of safe App Server-discovered workspaces.
- Japanese Study 1.2.1 adopts `learning-content-v8.1` with bounded diagnosis catalog reads,
  profile-aware level scope, and structured practice-v2 target assessments.

### Changed

- MCP Control Center now adopts all seven production MCP components and uses a dedicated framed
  result-pipe wrapper so inherited component child handles cannot keep bounded actions open.
- Personal Asset OS removes the duplicated Quick Capture manager action and keeps daily capture in
  the product-owned dashboard and authenticated mobile flow.
- Japanese Study and English Study desktop launchers now target their component-owned fixed Hub
  endpoints.

### Fixed

- Memory Core lifecycle recovery now distinguishes stale or reused managed PIDs from an active
  owned listener before deciding whether a component is running.
- Codex Bridge cancellation and startup recovery now settle stale pending approvals, and its MCP
  Apps widget no longer overflows narrow containers.
- Japanese Study validates practice contract-version invariants before preview or record requests
  can reach the Hub.

### Security

- Project Reading denies Codex credential, capability, installation, global-state, and session-index
  filenames when a reviewed `.codex` directory is configured as a named root.
- Personal Asset OS keeps broker credentials, raw holdings, mobile device identifiers, and runtime
  state outside the repository and outside its persisted ledger and valuation snapshots.
- Workspace ignore rules also exclude transitional SQLite restore WAL and shared-memory sidecars.

## 1.1.0 - 2026-08-16

Workspace minor release after reorganizing the seven MCP components and Control Center. Each
component advances its existing application/package minor version without renumbering protocol,
schema, registry, or domain-contract versions.

### Added

- English Study is now present as an independent, disabled-by-default bounded MCP component.
- OMI Search includes the source for its MCP Apps Taiwan market dashboard widget.

### Changed

- Project Reading `project_map` now exposes independent file, total-symbol, and per-file symbol
  limits while retaining `maxResults` as a deprecated `maxFiles` alias for compatibility.
- Workspace and component application/package versions advance to their next minor releases.

## 1.0.0 - 2026-08-10

First complete source release of the six MCP components and MCP Control Center. Component
application/package versions are aligned at `1.0.0`; independent protocol and data-contract
versions retain their existing identifiers.

### Added

- Public security policy and contribution guidance for the source-only monorepo.
- Focused security, contract, operations, lifecycle, recovery, and troubleshooting documentation
  for `project_reading`, `OMI_search`, `Memory Core`, `japanese_study`, `codex_bridge`, and
  `personal-asset-os`.
- Explicit ledger, read-only MCP, backup/recovery, and USB mobile-ingest documentation for
  `personal-asset-os`.
- GitHub community health files, structured issue forms, pull-request guidance, code ownership,
  support guidance, and repository conduct standards.
- Repository About metadata, discoverability topics, and private vulnerability reporting.

### Changed

- Component READMEs now act as documentation entrypoints instead of carrying every operational and
  contract detail inline.
- Memory Core public documentation no longer relies on an ignored local agent-run path.

### Security

- Documented public-report redaction requirements, local/private runtime exclusions, component
  trust boundaries, exact-path process ownership, and the rule that secrets/private data never
  enter Git.

## Repository history

The initial public source-only workspace was published on 2026-07-26. Existing history before this
changelog remains available in Git commits. The `1.0.0` section is the first workspace-wide source
release; runtime deployment and external connector adoption remain separately verified events.
