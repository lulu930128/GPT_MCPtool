import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AutomationOverlay } from "./types.js";

const MAX_AUTOMATION_FILE_BYTES = 128 * 1024;
const ALLOWED_KEYS = new Set(["name", "status", "rrule", "target_thread_id", "created_at", "updated_at"]);

export class AutomationRegistry {
  private cache?: { expiresAt: number; automations: AutomationOverlay[] };

  constructor(private readonly codexHome: string, private readonly cacheTtlMs = 5_000) {}

  async list(force = false): Promise<AutomationOverlay[]> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) {
      return structuredClone(this.cache.automations);
    }
    const root = resolve(this.codexHome, "automations");
    const automations: AutomationOverlay[] = [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.name)) continue;
      const path = join(root, entry.name, "automation.toml");
      let resolvedPath: string;
      try {
        resolvedPath = await realpath(path);
        const rootPath = await realpath(root);
        const rel = relative(rootPath, resolvedPath);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        const info = await stat(resolvedPath);
        if (!info.isFile() || info.size > MAX_AUTOMATION_FILE_BYTES) continue;
      } catch {
        continue;
      }
      try {
        const parsed = parseAutomationToml(await readFile(resolvedPath, "utf8"));
        const targetThreadId = parsed.target_thread_id;
        if (!isUuid(targetThreadId)) continue;
        automations.push({
          automationId: entry.name,
          name: bounded(parsed.name || entry.name, 160),
          status: parsed.status === "ACTIVE" || parsed.status === "PAUSED" ? parsed.status : "UNKNOWN",
          schedule: bounded(parsed.rrule || "", 2_000),
          targetThreadId,
          createdAt: epochMillisToIso(parsed.created_at),
          updatedAt: epochMillisToIso(parsed.updated_at),
        });
      } catch {
        continue;
      }
    }
    automations.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.automationId.localeCompare(right.automationId));
    this.cache = { expiresAt: Date.now() + this.cacheTtlMs, automations };
    return structuredClone(automations);
  }
}

function parseAutomationToml(content: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match || !ALLOWED_KEYS.has(match[1]!)) continue;
    output[match[1]!] = parseTomlScalar(match[2]!);
  }
  return output;
}

function parseTomlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value.trim();
}

function epochMillisToIso(value: string | undefined): string | undefined {
  if (!value || !/^\d{10,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  const date = new Date(parsed);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f-]{36}$/i.test(value));
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
