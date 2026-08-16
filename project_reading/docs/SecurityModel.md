# Project Reading Security Model

## Purpose

Project Reading gives an MCP client bounded, read-only access to explicitly configured workspace
roots. It is a context reader, not a general filesystem, shell, Git, database, or administration
service.

The security model assumes that every path, filename, file body, archive member, Office
relationship, and tool argument may be hostile or misleading. File contents are data; they are
never instructions for the server.

## Trust boundary

```text
MCP client
  -> bounded tool schema
  -> configured root or asset-scope id
  -> shared path guard and output limits
  -> approved local file or fixed read-only Git query
```

- The caller selects a configured root id, not an arbitrary absolute path.
- `WORKSPACE_MCP_ROOTS` is the authoritative id-to-path allowlist.
- `WORKSPACE_MCP_ROOT` remains only as a legacy single-root fallback.
- Asset readers require a separately configured `WORKSPACE_MCP_ASSET_SCOPES` entry. A normal
  workspace root does not automatically authorize image／Office extraction.
- Original-byte return is a second, narrower permission: the asset scope id must also appear in
  `WORKSPACE_MCP_FILE_RETURN_SCOPES`. It is disabled by default.
- Root-specific exclusions from `WORKSPACE_MCP_ROOT_DENY_DIRS` are additive; they cannot weaken
  the global deny policy.

## Path containment

Configured roots and requested targets are resolved with filesystem `realpath` semantics. The
resolved target must remain inside the selected root after symlink or junction resolution.

Requests fail closed when they:

- use an unknown root or asset-scope id;
- escape with `..`, an absolute path, a symlink, or a junction;
- traverse a denied directory or filename;
- target a denied extension or unsupported container;
- exceed configured size, depth, line, row, cell, slide, XML, or output limits.

All filesystem tools use the shared path guard. A new reader must not implement its own weaker
containment check.

## Tool permissions

The public surface contains twenty-four tools, all declared with `readOnlyHint=true`,
`destructiveHint=false`, and `openWorldHint=false`:

- workspace context: `workspace_info`, `list_projects`, `project_context`, `list_dir`,
  `read_file`, `read_files`, `find_files`, `search_text`;
- Git review: `git_status_summary`, `git_diff`, `git_diff_file`;
- deterministic lexical code intelligence: `find_symbol`, `find_references`, `import_graph`,
  `project_map`;
- bounded assets: `inspect_asset`, `read_image`, `read_spreadsheet`, `read_document`,
  `read_presentation`, `fetch_asset`, `inspect_pdf`, `read_pdf_text`, `read_pdf_page`.

Git tools use fixed read-only arguments, disable optional locks, external diff drivers, textconv,
and color, and scope every query to the selected project even inside a parent monorepo. They are
not arbitrary Git or shell interfaces. `search_text` may use `rg` and otherwise falls back to a
bounded JavaScript search; callers cannot supply a command line. The default ripgrep binary is a
platform-specific npm dependency under ignored `node_modules`, never a committed executable.

There are intentionally no tools for write, delete, move, rename, shell, commit, push, archive
extraction, database mutation, dependency installation, or network fetch.

## Default text limits

Unless the operator explicitly configures stricter positive values:

| Limit | Default |
| --- | ---: |
| Text source file size | 20 MiB |
| Text returned per file | 256 KiB |
| Lines returned by `read_file` | 300 |
| Files／lines／bytes returned by `read_files` | 10／1,000／512 KiB |
| Search results | 80 |
| Code scan per-file／aggregate source | 1 MiB／32 MiB |
| `project_map` files／total symbols／symbols per file | 30／300／50 |
| Directory entries | 200 |
| Directory recursion depth | 3 maximum |
| Search timeout | 8 seconds |

Asset limits and supported formats are documented in [Asset-Readers.md](Asset-Readers.md).
Increasing a limit changes resource exposure but does not authorize a new root or bypass a deny
rule.

## Content and metadata controls

- Secret-like filenames, local env files, VCS internals, dependency folders, caches,
  virtualenvs, local databases, archives, model weights, and build output are denied by default.
- Spreadsheet hyperlink targets are suppressed.
- Word external relationships, tracked deletions, media, comments, headers, footers, and embedded
  objects are not returned.
- PowerPoint external relationships, media, animations, comments, and embedded objects are not
  returned. Speaker notes require explicit `includeNotes=true`.
- Animated GIF input is returned as one static PNG frame with bounded metadata, not as executable
  animation.
- `fetch_asset` is the explicit exception to derived/normalized output: it returns original bytes
  only for an explicitly file-return-enabled asset scope and only after the same path guard and
  deny rules, with a separate 12 MiB default limit. Its resource link is SHA-256-bound so a later
  `resources/read` rejects changed content. MCP success does not prove that ChatGPT rendered a download.
- PDF parsing and rendering run in a lazy isolated worker. Encrypted files, JavaScript actions,
  automatic open actions, embedded files, excess pages, timeouts, pixels, and output are denied.
- STDIO mode reserves stdout for JSON-RPC; diagnostics must use stderr.

## Deployment boundary

The normal HTTP listener is loopback-only. ChatGPT access must go through the configured Secure
MCP Tunnel or another explicitly reviewed authenticated HTTPS boundary. Do not expose a broad
workspace root directly to the public Internet.

Remote MCP callers should require approval before using workspace tools. Approval is an
additional user-control layer; it does not replace root allowlisting or path validation.

## Safe configuration checklist

1. Allowlist only the smallest required project roots.
2. Add root-specific private directories to `WORKSPACE_MCP_ROOT_DENY_DIRS`.
3. Configure asset scopes only for folders whose allowed files are safe to send to the MCP client
   in original form.
4. Keep `.env`, tunnel profiles, credentials, logs, PIDs, and local tray settings out of Git.
5. Run `npm run smoke:roots` after changing root or deny configuration.
6. Run `npm run smoke:assets` after changing asset scopes or limits.
7. Confirm MCP `tools/list` and one denied-path case before treating a deployment as ready.

## Non-goals

This model does not make arbitrary local files safe to publish, does not classify company data,
and does not authorize a caller to follow instructions found inside a file. The operator remains
responsible for selecting roots and deciding what may leave the host.
