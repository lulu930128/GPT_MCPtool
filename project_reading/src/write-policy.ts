import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorkspaceRootConfig } from "./config.js";
import { isWithinRoot, validateWriteRelativePath, inspectWritePath, inspectOperatorStatePath } from "./path-guard.js";
import { WorkspaceWriteError } from "./write-errors.js";
import { readUtf8Snapshot } from "./text-snapshot.js";

export const WRITE_TOOLS = ["create_text_file", "append_text_file", "patch_text_file", "update_json_value", "make_directory"] as const;
export type WriteTool = typeof WRITE_TOOLS[number];
const operationSchema = z.enum(WRITE_TOOLS);
const pathSchema = z.string().min(1).max(512);
const fieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "null", "object", "array"]),
  enum: z.array(z.unknown()).min(1).max(64).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  maxLength: z.number().int().nonnegative().max(262144).optional(),
}).strict().superRefine((field, ctx) => {
  const numeric = field.type === "number" || field.type === "integer";
  if ((!numeric && (field.minimum !== undefined || field.maximum !== undefined)) ||
      (field.maxLength !== undefined && field.type !== "string") ||
      (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Field constraints must match the declared type and bounds." });
  }
});
const ruleSchema = z.object({
  root: z.string().min(1).max(32),
  path: pathSchema,
  operations: z.array(operationSchema).min(1).max(5),
  extensions: z.array(z.string().regex(/^(\.[a-z0-9]+|\*)$/)).max(64).default([]),
  jsonFields: z.record(fieldSchema).optional(),
}).strict();
export const writePolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  defaultRootAccess: z.enum(["read-only", "read-write"]).default("read-only"),
  rules: z.array(ruleSchema).max(128).default([]),
  deny: z.array(z.object({ root: z.string(), path: pathSchema }).strict()).max(128).default([]),
  limits: z.object({
    maxPayloadBytes: z.number().int().min(1).max(262144).default(262144),
    maxFileBytes: z.number().int().min(1).max(8388608).default(2097152),
    maxOperations: z.number().int().min(1).max(10000).default(2048),
    maxWrittenBytes: z.number().int().min(1).max(1073741824).default(67108864),
    maxStateBytes: z.number().int().min(65536).max(268435456).default(33554432),
  }).strict().default({}),
}).strict();
export type WritePolicyDocument = z.infer<typeof writePolicySchema>;
export type WriteRule = z.infer<typeof ruleSchema>;
export interface WritePolicy {
  enabled: boolean;
  reason: string;
  policyPath?: string;
  digest?: string;
  stateDirectory?: string;
  document?: WritePolicyDocument;
  rootPaths?: Map<string, string>;
  protectedPaths: string[];
}

// This module is compiled into dist/src, like runtime-identity.ts.
export const componentDirectory = fileURLToPath(new URL("../../", import.meta.url));

export async function loadWritePolicy(env: NodeJS.ProcessEnv, roots: Map<string, WorkspaceRootConfig>): Promise<WritePolicy> {
  const protectedPaths = [componentDirectory, path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".agents")];
  const disabled = (reason: string): WritePolicy => ({ enabled: false, reason, protectedPaths });
  const configuredPath = env.WORKSPACE_MCP_WRITE_POLICY?.trim();
  if (!configuredPath) return disabled("not_configured");
  try {
    if (!path.isAbsolute(configuredPath)) throw new Error("Policy path must be absolute.");
    await inspectWritePath(configuredPath);
    const snapshot = await readUtf8Snapshot(configuredPath, 262144);
    const document = writePolicySchema.parse(JSON.parse(snapshot.text));
    if (!document.enabled) return disabled("policy_disabled");
    if (document.defaultRootAccess === "read-write") {
      for (const root of roots.values()) {
        if (protectedPaths.some((protectedPath) => isWithinRoot(protectedPath, root.path))) continue;
        document.rules.push({ root: root.id, path: "**", operations: [...WRITE_TOOLS], extensions: ["*"] });
      }
    }
    if (!document.rules.length) throw new Error("No write rules.");
    const policyPath = await fs.realpath(configuredPath);
    const configuredStateDirectory = env.WORKSPACE_MCP_WRITE_STATE_DIR?.trim() ||
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "ProjectWorkspace", "write-state");
    if (!path.isAbsolute(configuredStateDirectory)) throw new Error("State path must be absolute.");
    assertWriteStateOutsideRoots(configuredStateDirectory, Array.from(roots.values(), (root) => root.path));
    const stateDirectory = (await inspectOperatorStatePath(configuredStateDirectory)).canonicalPath;
    assertWriteStateOutsideRoots(stateDirectory, Array.from(roots.values(), (root) => root.path));
    const protectedAll = [...protectedPaths, policyPath, configuredStateDirectory, stateDirectory];
    for (const entry of [...document.rules, ...document.deny]) {
      if (!roots.has(entry.root)) throw new Error("Unknown write root.");
      if (entry.path !== "**") validateWriteRelativePath(scopeBase(entry.path));
    }
    for (const rule of document.rules) {
      if (rule.operations.some((operation) => operation !== "make_directory") && !rule.extensions.length) {
        throw new Error("File operations require explicit extensions.");
      }
      if (rule.jsonFields) {
        if (rule.path.endsWith("/**") || !rule.path.toLowerCase().endsWith(".json") || !rule.extensions.includes(".json") ||
            rule.operations.some((operation) => operation !== "update_json_value") || !Object.keys(rule.jsonFields).length) {
          throw new Error("Field restrictions require an exact JSON file and JSON-only operations.");
        }
        for (const pointer of Object.keys(rule.jsonFields)) parseJsonPointer(pointer);
      }
    }
    return { enabled: true, reason: "enabled", policyPath, digest: snapshot.sha256, stateDirectory,
      document, rootPaths: new Map(Array.from(roots.values(), (root) => [root.id, root.path])), protectedPaths: protectedAll };
  } catch {
    return disabled("invalid_policy");
  }
}

export function assertWriteStateOutsideRoots(stateDirectory: string, roots: Iterable<string>): void {
  for (const root of roots) {
    if (isWithinRoot(root, stateDirectory) || isWithinRoot(stateDirectory, root)) {
      throw new WorkspaceWriteError("PATH_DENIED", "Write state must be outside all workspace roots, including its physical path.");
    }
  }
}

export async function assertPolicyCurrent(policy: WritePolicy): Promise<void> {
  if (!policy.enabled || !policy.policyPath || !policy.digest) throw new WorkspaceWriteError("WRITE_DISABLED");
  try {
    await inspectWritePath(policy.policyPath);
    const snapshot = await readUtf8Snapshot(policy.policyPath, 262144);
    if (snapshot.sha256 !== policy.digest) throw new Error("Changed policy.");
  } catch {
    throw new WorkspaceWriteError("WRITE_DISABLED", "Write policy changed or is unavailable; operator reload is required.");
  }
}

export function scopeBase(scope: string): string {
  return scope.endsWith("/**") ? scope.slice(0, -3) : scope;
}

export function matchesScope(scope: string, relative: string): boolean {
  if (scope === "**") return true;
  const base = scopeBase(scope).replaceAll("\\", "/").toLowerCase();
  const target = relative.replaceAll("\\", "/").toLowerCase();
  return target === base || (scope.endsWith("/**") && target.startsWith(`${base}/`));
}

export function authorizeWrite(policy: WritePolicy, root: string, relative: string, operation: WriteTool): WriteRule[] {
  if (!policy.enabled || !policy.document) throw new WorkspaceWriteError("WRITE_DISABLED");
  const selectedRoot = policy.rootPaths?.get(root);
  if (!selectedRoot) throw new WorkspaceWriteError("WRITE_POLICY_DENIED");
  const absolute = path.resolve(selectedRoot, relative);
  const matchesPhysicalPath = (rule: { root: string; path: string }): boolean => {
    const ruleRoot = policy.rootPaths?.get(rule.root);
    return Boolean(ruleRoot && isWithinRoot(ruleRoot, absolute) && matchesScope(rule.path, path.relative(ruleRoot, absolute)));
  };
  if (policy.document.deny.some(matchesPhysicalPath)) {
    throw new WorkspaceWriteError("WRITE_POLICY_DENIED");
  }
  const matches = policy.document.rules.filter(matchesPhysicalPath);
  // Exact field restrictions cannot be bypassed through an overlapping broad grant.
  if (matches.some((rule) => rule.jsonFields) && operation !== "update_json_value") {
    throw new WorkspaceWriteError("WRITE_POLICY_DENIED");
  }
  const allowed = matches.filter((rule) => rule.root === root && rule.operations.includes(operation));
  if (!allowed.length) throw new WorkspaceWriteError("WRITE_POLICY_DENIED");
  if (operation !== "make_directory" && !allowed.some((rule) => rule.extensions.includes("*") || rule.extensions.includes(path.extname(relative).toLowerCase()))) {
    throw new WorkspaceWriteError("EXTENSION_DENIED");
  }
  return matches;
}

export function parseJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw new WorkspaceWriteError("INVALID_JSON_POINTER");
  const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length > 32 || parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new WorkspaceWriteError("INVALID_JSON_POINTER");
  }
  return parts;
}

export function validateJsonField(rules: WriteRule[], pointer: string, value: unknown): void {
  for (const rule of rules) {
    if (!rule.jsonFields) continue;
    const field = Object.hasOwn(rule.jsonFields, pointer) ? rule.jsonFields[pointer] : undefined;
    if (!field) throw new WorkspaceWriteError("WRITE_POLICY_DENIED");
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if ((field.type === "integer" ? !(typeof value === "number" && Number.isInteger(value)) : field.type !== type) ||
        (typeof value === "number" && (!Number.isFinite(value) ||
          (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) ||
        (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength) ||
        (field.enum && !field.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))) {
      throw new WorkspaceWriteError("VALIDATION_FAILED");
    }
  }
}

export async function writeCapabilities(policy: WritePolicy) {
  let enabled = policy.enabled;
  let reason = policy.reason;
  if (enabled) {
    try { await assertPolicyCurrent(policy); }
    catch { enabled = false; reason = "policy_changed_or_unavailable"; }
  }
  return { enabled, reason, policyVersion: policy.document?.version ?? null,
    defaultRootAccess: policy.document?.defaultRootAccess ?? "read-only",
    policyDigest: policy.digest ?? null, tools: enabled ? [...WRITE_TOOLS, "get_write_operation"] : [],
    rules: policy.document?.rules ?? [], limits: policy.document?.limits ?? null };
}
