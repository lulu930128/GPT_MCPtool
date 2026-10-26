# Project Reading Security Model

## Purpose

Project Reading gives an MCP client bounded access to explicitly configured workspace roots.
It is read-only by default. An independent operator policy can enable restricted text operations;
it does not expose shell, Git mutation, database mutation, or arbitrary administration.

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

The default public surface contains thirty-one tools, all declared with `readOnlyHint=true`
and `destructiveHint=false`. The following twenty-five workspace tools use `openWorldHint=false`:

- workspace context: `workspace_info`, `list_projects`, `project_context`, `list_dir`,
  `read_file`, `read_files`, `find_files`, `search_text`;
- Git review: `git_status_summary`, `git_diff`, `git_diff_file`;
- deterministic lexical code intelligence: `find_symbol`, `find_references`, `import_graph`,
  `project_map`;
- bounded assets: `inspect_asset`, `read_image`, `read_spreadsheet`, `read_document`,
  `read_presentation`, `fetch_asset`, `read_audio`, `inspect_pdf`, `read_pdf_text`, `read_pdf_page`.

Operate mode adds five write tools with `readOnlyHint=false`, plus read-only
`get_write_operation`. See [Write Operations](Write-Operations.md) for independent per-path,
per-operation permissions, optional JSON field constraints, Windows path checks, authenticated
HTTP requirements, original-byte hashes, atomic publication, durable retry receipts, and audit.
Annotations describe behavior; server-side checks enforce authority on every mutation.

### Security-reviewed runtime diagnostics (2026-10-05)

The six additive tools are `check_tcp_port`, `list_listening_ports`, `inspect_port_owner`,
`resolve_dns`, `ping_host`, and `http_health_check`. Network tools declare `openWorldHint=true`;
local listener/owner tools declare false. These observations do not require a write policy.
Loopback, private and public network targets are intentionally permitted: an authenticated
client can learn network reachability and bounded endpoint responses beyond workspace roots.
Keep the existing authenticated transport/tunnel boundary; never expose it publicly without auth.

- Every input is a strict object. Hostnames are ASCII DNS labels or IP literals; ports are
  integers 1–65535. Unknown fields and command/option injection strings are rejected before IO.
- TCP/DNS/HTTP use Node native APIs. DNS uses a request-local cancellable resolver for A/AAAA;
  it does not read the hosts file. TCP/HTTP deadlines include connection and response time.
- Only `%SystemRoot%/System32/netstat.exe -ano`, `tasklist.exe /FO CSV /NH`, and
  `ping.exe -n 1 -w <validated timeout> <validated host>` are permitted diagnostic subprocesses.
  Only TCP LISTENING rows are returned, including IPv6 (Windows `-p tcp` omits TCPv6).
  The operator-owned SystemRoot, fixed cwd and minimal environment are not MCP arguments.
  No PATH lookup, raw args, shell, cmd /c, powershell -Command, pipe/redirection/chaining,
  caller env/cwd, arbitrary executable or parallel process runner is exposed.
- The existing `runBoundedProcess()` owns shell:false, ignored stdin, stdout/stderr caps and
  termination of only its own diagnostic child on timeout/output cap. Target processes,
  services, databases and files cannot be changed through these tools.
- Total per-call timeout is 100–10000 ms (default 3000), including both owner snapshots.
  Results are capped at 100 (default 50); subprocess capture is 256 KiB stdout/4 KiB stderr;
  ping exposes at most 2048 characters. At most eight probes run concurrently across sessions.
- HTTP is GET only: no supplied headers/body/auth/cookies, redirects or TLS bypass; accepted
  URLs are HTTP(S), <=2048 characters, without credentials or fragments. Headers are capped
  at 8 KiB; body capture is 0–16 KiB (default 1 KiB), with no automatic decompression. An absolute
  timer destroys the request even for slow/trickling responses. Use only known observation
  endpoints: GET semantics cannot prevent a badly designed remote endpoint from mutating state.
- Non-2xx HTTP is observed evidence, not a transport error. Truncation, DNS partial family
  errors and unavailable process names are explicit; incomplete collection cannot prove
  absence of a listener. ICMP exit 0 can mean destination-unreachable; echo evidence is separate.
- `inspect_port_owner.ok`/`complete` describe the listener observation. When that snapshot succeeds,
  tasklist failure preserves ok=true and valid listener/PID evidence, with partial=true,
  identityComplete=false, identityCode and per-row identityStatus=unavailable/processName=null.
  Identity timeouts/output limits are also partial identity evidence; a failed or timed-out
  listener snapshot still has ok=false/complete=false. A disappeared PID uses PROCESS_NOT_OBSERVED.
- Process identity means sampled image name/PID, not full path, command line, user identity,
  atomic identity or lifecycle authority. PID reuse and races remain possible. Filesystem
  access still belongs to path-guard; Codex Bridge execution and lifecycle actions stay separate.

Security review covers schema-to-argument construction, fixed executable selection, bounded
resources, error/partial semantics and transport annotations. Tests in `diagnostics.test.ts`
exercise these boundaries, including protocol-level unknown-key rejection and runner caps.
Network/body/command output is untrusted data and must never become instructions or commands.

Git tools use fixed read-only arguments, disable optional locks, external diff drivers, textconv,
and color, and scope every query to the selected project even inside a parent monorepo. They are
not arbitrary Git or shell interfaces. `search_text` may use `rg` and otherwise falls back to a
bounded JavaScript search; callers cannot supply a command line. The default ripgrep binary is a
platform-specific npm dependency under ignored `node_modules`, never a committed executable.

There are intentionally no tools for delete, move, rename, shell, commit, push, archive
extraction, database mutation, or dependency installation. Write policy does not authorize
execution of the files it permits editing.

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
- Codex credential and runtime-identity files such as `auth.json`, `cap_sid`,
  `installation_id`, global state, and session indexes are denied even when a reviewed `.codex`
  directory is configured as its own named root.
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

## 2026-10-14：明確單元件人工維護例外

現行 source contract `2026-10-14.1` 的 `mcp_component_restart` 接受七白名單元件的固定 reload，
需 `interrupt_current_requests` 與 UUID，重用 authenticated loopback HTTP；不驗證另一套
真人身分。其他 read tools 不發送維護 request；Workspace 自身、CC 與未知元件不開放。
UUID 綁定 componentId／action／confirmation；跨目標 replay 不派送，也不返回舊目標的成功收據。
TS 對 restart response 再核對這三欄，舊 owner 或錯誤 target receipt 一律 fail closed。
CC 原有 owner／component controller 保留 ownership 與 mutex，收據先 durable UNKNOWN
後執行，timeout 不重送。完整限制與尚未執行的 adoption 見 [本機管理](LocalComponentManagement.md)。
本文先前 G1／G2 source-attestation 前提不再套用此人工維護路徑；歷史證據保留。
