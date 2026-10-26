import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { assertWriteAncestorsUnchanged, resolveWorkspaceWritePath } from "./path-guard.js";
import { assertPolicyCurrent, authorizeWrite, parseJsonPointer, validateJsonField, type WriteTool } from "./write-policy.js";
import { operationIdSchema, writeInputSchemas, type WriteInputs } from "./write-inputs.js";
import { decodeUtf8, readUtf8Snapshot, sha256 } from "./text-snapshot.js";
import { errorCode, WorkspaceWriteError } from "./write-errors.js";
import { WriteJournal, type WriteReceipt, type WriteResult } from "./write-journal.js";

type Target = Awaited<ReturnType<typeof resolveWorkspaceWritePath>>;
interface PreparedWrite {
  target: Target;
  before?: Awaited<ReturnType<typeof readUtf8Snapshot>>;
  bytes?: Buffer;
  directories?: string[];
  result: Record<string, unknown>;
}
// Fault injection is local-test-only: no environment variable or MCP argument can supply hooks.
export interface WriteTestHooks {
  beforeCommit?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

export class WorkspaceWriter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: ServerConfig, private readonly hooks: WriteTestHooks = {}) {}

  async execute<T extends WriteTool>(tool: T, raw: unknown): Promise<WriteResult> {
    const parsed = writeInputSchemas[tool].safeParse(raw);
    if (!parsed.success) return { ok: false, operation_id: "", code: "VALIDATION_FAILED", applied: false };
    const args = parsed.data;
    args.operation_id = args.operation_id.toLowerCase();
    args.path = args.path.replaceAll("\\", "/");
    const task = this.queue.then(() => this.perform(tool, args));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async getOperation(id: string): Promise<Record<string, unknown>> {
    const operationId = operationIdSchema.parse(id).toLowerCase();
    await assertPolicyCurrent(this.config.writePolicy);
    const receipt = await new WriteJournal(this.config.writePolicy).read(operationId);
    if (!receipt) return { ok: false, operation_id: operationId, code: "OPERATION_NOT_FOUND" };
    if (receipt.policy_digest !== this.config.writePolicy.digest) return { ok: false, operation_id: operationId, code: "OPERATION_POLICY_CHANGED" };
    return receipt.status === "pending" ? unknownResult(operationId) : { ...receipt.result, replayed: true };
  }

  private async perform(tool: WriteTool, args: WriteInputs[WriteTool]): Promise<WriteResult> {
    const operationId = args.operation_id;
    let release: (() => Promise<void>) | undefined;
    let receipt: WriteReceipt | undefined;
    let journal: WriteJournal | undefined;
    let mutationStarted = false;
    try {
      await assertPolicyCurrent(this.config.writePolicy);
      const serialized = JSON.stringify({ tool, args }, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
      const payloadBytes = Buffer.byteLength(serialized);
      if (payloadBytes > this.config.writePolicy.document!.limits.maxPayloadBytes) throw new WorkspaceWriteError("PAYLOAD_TOO_LARGE");
      journal = new WriteJournal(this.config.writePolicy);
      release = await journal.lock();
      const requestDigest = sha256(serialized);
      const previous = await journal.read(operationId);
      if (previous) {
        if (previous.request_digest !== requestDigest) throw new WorkspaceWriteError("OPERATION_ID_CONFLICT");
        if (previous.policy_digest !== this.config.writePolicy.digest) throw new WorkspaceWriteError("OPERATION_POLICY_CHANGED");
        return previous.status === "pending" ? unknownResult(operationId) : { ...previous.result!, replayed: true };
      }
      await journal.ensureCapacity(payloadBytes);
      receipt = { version: 1, operation_id: operationId, request_digest: requestDigest,
        policy_digest: this.config.writePolicy.digest!, status: "pending", charged_bytes: payloadBytes };
      await journal.begin(receipt);
      await journal.audit({ operation_id: operationId, tool, root: args.root, path: args.path,
        policy_digest: receipt.policy_digest, request_digest: requestDigest, result: "started" });
      const prepared = await this.prepare(tool, args);
      if (prepared.result.changed) {
        await this.hooks.beforeCommit?.();
        await assertPolicyCurrent(this.config.writePolicy);
        await this.recheck(prepared, args);
        await this.commit(prepared, args, () => { mutationStarted = true; });
        await this.hooks.afterCommit?.();
      }
      const result: WriteResult = { ok: true, operation_id: operationId, root: args.root, path: args.path,
        ...prepared.result, replayed: false };
      await journal.audit({ operation_id: operationId, result: "success", changed: result.changed,
        old_sha256: result.old_sha256, new_sha256: result.new_sha256 ?? result.sha256 });
      await journal.complete(receipt, result);
      return result;
    } catch (error) {
      if (!(error instanceof WorkspaceWriteError)) {
        console.error("Project Workspace write I/O failed", { operation_id: operationId,
          code: errorCode(error) ?? "INTERNAL_ERROR", publicationStarted: mutationStarted,
          syscall: error && typeof error === "object" && "syscall" in error ? error.syscall : undefined });
      }
      const result: WriteResult = mutationStarted ? unknownResult(operationId) : {
        ok: false, operation_id: operationId, applied: false,
        code: error instanceof WorkspaceWriteError ? error.code : "WRITE_FAILED",
      };
      if (journal && receipt) {
        try {
          await journal.audit({ operation_id: operationId, result: mutationStarted ? "unknown" : "rejected", reason: result.code });
          if (!mutationStarted) await journal.complete(receipt, result);
        } catch {
          // The durable pending receipt blocks retries even if the final audit cannot be saved.
          return { ...result, auditComplete: false };
        }
      }
      return result;
    } finally {
      if (release) {
        try { await release(); }
        catch { console.error("Project Workspace writer lock release failed; operator inspection required."); }
      }
    }
  }

  private async prepare(tool: WriteTool, args: WriteInputs[WriteTool]): Promise<PreparedWrite> {
    const target = await resolveWorkspaceWritePath(this.config, args.path, args.root);
    const rules = authorizeWrite(this.config.writePolicy, args.root, target.relative, tool);
    if (tool === "make_directory") {
      if (target.stat && !target.stat.isDirectory()) throw new WorkspaceWriteError("FILE_EXISTS");
      const directories: string[] = [];
      let cursor = target.absolute;
      while (!target.ancestors.some((item) => item.path.toLowerCase() === cursor.toLowerCase())) {
        const relative = path.relative(target.rootPath, cursor).split(path.sep).join("/");
        // Every created ancestor needs its own directory permission.
        await resolveWorkspaceWritePath(this.config, relative, args.root);
        authorizeWrite(this.config.writePolicy, args.root, relative, tool);
        directories.unshift(cursor);
        cursor = path.dirname(cursor);
      }
      if (!(args as WriteInputs["make_directory"]).parents && directories.length > 1) throw new WorkspaceWriteError("PARENT_NOT_FOUND");
      return { target, directories, result: { changed: directories.length > 0, created: directories.length > 0,
        directories_created: directories.length } };
    }
    if (target.stat && !target.stat.isFile()) throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE");
    if (tool === "create_text_file" && target.stat) throw new WorkspaceWriteError("FILE_EXISTS");
    if (!target.ancestors.some((item) => item.path.toLowerCase() === path.dirname(target.absolute).toLowerCase())) {
      throw new WorkspaceWriteError("PARENT_NOT_FOUND", "Create the parent using make_directory first.");
    }
    const maxFileBytes = this.config.writePolicy.document!.limits.maxFileBytes;
    const before = target.stat ? await readUtf8Snapshot(target.absolute, maxFileBytes) : undefined;
    if (before && target.stat && (before.stat.ino !== target.stat.ino || before.stat.dev !== target.stat.dev)) throw new WorkspaceWriteError("PATH_CHANGED");
    if ("expected_sha256" in args && args.expected_sha256 !== undefined && args.expected_sha256 !== before?.sha256) {
      throw new WorkspaceWriteError("HASH_MISMATCH");
    }
    let text: string;
    let details: Record<string, unknown> = {};
    if (tool === "create_text_file") {
      text = (args as WriteInputs["create_text_file"]).content;
    } else if (tool === "append_text_file") {
      const input = args as WriteInputs["append_text_file"];
      if (!before && !input.create_if_missing) throw new WorkspaceWriteError("FILE_NOT_FOUND");
      text = (before?.text ?? "") + input.content;
      details = { bytes_appended: Buffer.byteLength(input.content) };
    } else {
      if (!before) throw new WorkspaceWriteError("FILE_NOT_FOUND");
      if (tool === "patch_text_file") {
        text = before.text;
        const input = args as WriteInputs["patch_text_file"];
        for (const operation of input.operations) {
          const count = text.split(operation.find).length - 1;
          if (!count) throw new WorkspaceWriteError("PATCH_TARGET_NOT_FOUND");
          if (count !== operation.expected_count) throw new WorkspaceWriteError("PATCH_TARGET_NOT_UNIQUE");
          text = text.split(operation.find).join(operation.replace);
          if (Buffer.byteLength(text) > maxFileBytes) throw new WorkspaceWriteError("PAYLOAD_TOO_LARGE");
        }
        details = { operations_applied: input.operations.length, diff: boundedDiff(before.text, text) };
      } else {
        const input = args as WriteInputs["update_json_value"];
        if (path.extname(args.path).toLowerCase() !== ".json") throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE");
        validateJsonField(rules, input.json_pointer, input.value);
        const update = updateJson(before.text, input.json_pointer, input.value);
        text = update.text;
        details = { json_pointer: input.json_pointer, ...boundedValue("old_value", update.oldValue),
          ...boundedValue("new_value", input.value), formatting: "preserve-indent-newline-bom; JSON reserialized" };
      }
    }
    const bytes = Buffer.from(text, "utf8");
    // Reject unpaired surrogates rather than silently replacing user characters.
    if (decodeUtf8(bytes) !== text) throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE");
    if (bytes.length > maxFileBytes) throw new WorkspaceWriteError("PAYLOAD_TOO_LARGE");
    validateStructuredText(args.path, text);
    const changed = !before || !bytes.equals(before.bytes);
    return { target, before, bytes, result: { changed, created: !before, old_sha256: before?.sha256 ?? null,
      new_sha256: sha256(bytes), sha256: sha256(bytes), new_size: bytes.length, ...details } };
  }

  private async recheck(prepared: PreparedWrite, args: WriteInputs[WriteTool]): Promise<void> {
    await assertWriteAncestorsUnchanged(prepared.target.ancestors);
    const current = await resolveWorkspaceWritePath(this.config, args.path, args.root);
    if (prepared.before) {
      if (!current.stat || current.stat.ino !== prepared.before.stat.ino || current.stat.dev !== prepared.before.stat.dev) {
        throw new WorkspaceWriteError("HASH_MISMATCH");
      }
      const snapshot = await readUtf8Snapshot(current.absolute, this.config.writePolicy.document!.limits.maxFileBytes);
      if (snapshot.sha256 !== prepared.before.sha256) throw new WorkspaceWriteError("HASH_MISMATCH");
    } else if (current.stat && prepared.result.changed) {
      throw new WorkspaceWriteError("FILE_EXISTS");
    }
  }

  private async commit(prepared: PreparedWrite, args: WriteInputs[WriteTool], publishing: () => void): Promise<void> {
    if (prepared.directories) {
      for (const directory of prepared.directories) {
        await assertWriteAncestorsUnchanged(prepared.target.ancestors);
        const relative = path.relative(prepared.target.rootPath, directory).split(path.sep).join("/");
        await resolveWorkspaceWritePath(this.config, relative, args.root);
        publishing();
        await fs.mkdir(directory, { mode: 0o700 });
      }
      return;
    }
    const temporary = path.join(path.dirname(prepared.target.absolute), `.workspace-write-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", prepared.before ? prepared.before.stat.mode & 0o777 : 0o600);
      try {
        await handle.writeFile(prepared.bytes!);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforePublish?.();
      await assertPolicyCurrent(this.config.writePolicy);
      await this.recheck(prepared, args);
      publishing();
      if (prepared.before) await fs.rename(temporary, prepared.target.absolute);
      else await fs.link(temporary, prepared.target.absolute); // Atomic no-clobber publication.
    } finally {
      await fs.unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") console.error("Project Workspace temporary file cleanup failed; operator inspection required.");
      });
    }
  }
}

const writers = new WeakMap<ServerConfig, WorkspaceWriter>();
export function getWorkspaceWriter(config: ServerConfig): WorkspaceWriter {
  let writer = writers.get(config);
  if (!writer) { writer = new WorkspaceWriter(config); writers.set(config, writer); }
  return writer;
}

function unknownResult(operationId: string): WriteResult {
  return { ok: false, operation_id: operationId, code: "OPERATION_OUTCOME_UNKNOWN", applied: "unknown",
    retrySafe: false, message: "Inspect the target and protected operation receipt. Do not resend under a new ID." };
}

function boundedValue(name: string, value: unknown): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(value)) <= 4096 ? { [name]: value } : { [`${name}_omitted`]: true };
}

function boundedDiff(before: string, after: string) {
  let offset = 0;
  while (offset < Math.min(before.length, after.length) && before[offset] === after[offset]) offset += 1;
  const start = Math.max(0, offset - 80);
  return { format: "bounded-context", startCharacter: start, before: before.slice(start, start + 1024),
    after: after.slice(start, start + 1024), truncated: start > 0 || Math.max(before.length, after.length) > start + 1024 };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new WorkspaceWriteError("PARSE_ERROR"); }
}

function updateJson(original: string, pointer: string, value: unknown) {
  const parts = parseJsonPointer(pointer);
  const document = parseJson(original);
  assertJsonUpdateSafe(original, document);
  let parent = document;
  for (const part of parts.slice(0, -1)) parent = ownValue(parent, part);
  const key = parts.at(-1)!;
  const oldValue = ownValue(parent, key);
  if (JSON.stringify(oldValue) === JSON.stringify(value)) return { text: original, oldValue };
  (parent as Record<string, unknown>)[key] = value;
  assertJsonValuesSafe(document);
  const indent = original.match(/(?:\r?\n)([ \t]+)"/)?.[1] ?? (original.includes("\n") ? "  " : undefined);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const serialized = JSON.stringify(document, null, indent).replaceAll("\n", eol);
  return { text: `${original.startsWith("\uFEFF") ? "\uFEFF" : ""}${serialized}${original.endsWith("\n") ? eol : ""}`, oldValue };
}

function ownValue(parent: unknown, key: string): unknown {
  if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key) ||
      (Array.isArray(parent) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new WorkspaceWriteError("JSON_PATH_NOT_FOUND");
  return (parent as Record<string, unknown>)[key];
}

function validateStructuredText(filename: string, text: string): void {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".json") parseJson(text);
  if (extension === ".jsonl") {
    if (text && !text.endsWith("\n")) throw new WorkspaceWriteError("VALIDATION_FAILED", "JSONL records must end with a newline.");
    if (text) for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, -1)) parseJson(line);
  }
}

/** Prevent JSON reserialization from silently dropping duplicate keys or rounding large integers. */
function assertJsonUpdateSafe(source: string, document: unknown): void {
  assertJsonValuesSafe(document);
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/g) ?? [];
  let index = 0;
  function visit(): void {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[index] !== "}") {
        const key = JSON.parse(tokens[index++]) as string;
        if (keys.has(key)) throw new WorkspaceWriteError("VALIDATION_FAILED", "JSON updates reject duplicate object keys.");
        keys.add(key);
        index++;
        visit();
        if (tokens[index] === ",") index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") {
        visit();
        if (tokens[index] === ",") index++;
      }
      index++;
    } else if (token && /^-?[0-9]/.test(token)) {
      if (token.length > 128 || normalizedDecimal(token) !== normalizedDecimal(JSON.stringify(Number(token)))) {
        throw new WorkspaceWriteError("VALIDATION_FAILED", "JSON updates reject numbers that would change during reserialization.");
      }
    }
  }
  visit();
}

function normalizedDecimal(token: string): string {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e");
  const decimals = coefficient.split(".")[1]?.length ?? 0;
  let digits = coefficient.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
  if (!digits) return coefficient.startsWith("-") ? "-0" : "0";
  let power = BigInt(exponent) - BigInt(decimals);
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); power += 1n; }
  return `${coefficient.startsWith("-") ? "-" : ""}${digits}e${power}`;
}

function assertJsonValuesSafe(document: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: document, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 64 || (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
      throw new WorkspaceWriteError("VALIDATION_FAILED", "JSON updates require bounded nesting and lossless integer values.");
    }
    if (value && typeof value === "object") for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
}
