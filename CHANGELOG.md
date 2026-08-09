# Changelog

This file records user-visible, contract, security, operations, and repository-structure changes.
The repository does not currently publish versioned GitHub releases, so entries under
`Unreleased` describe source changes that may not yet be deployed on a local runtime.

## Unreleased

### Added

- Public security policy and contribution guidance for the source-only monorepo.
- Focused security, contract, operations, lifecycle, recovery, and troubleshooting documentation
  for `project_reading`, `OMI_search`, `Memory Core`, `japanese_study`, `codex_bridge`, and
  `personal-asset-os`.
- Explicit ledger, read-only MCP, backup/recovery, and USB mobile-ingest documentation for
  `personal-asset-os`.

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
changelog remains available in Git commits and is not retroactively presented as a versioned
release. Future tagged releases should add dated sections here and distinguish source completion,
runtime deployment, and external connector adoption.
