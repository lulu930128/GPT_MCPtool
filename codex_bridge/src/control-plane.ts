import { z } from "zod";
import type { AppServerTransport } from "./app-server-client.js";
import { redactString } from "./redaction.js";

// Audited against the installed @openai/codex 0.154.0 experimental protocol.
// These schemas select fields; arbitrary nested server payloads never cross this boundary.
const text = z.string().transform((value) => redactString(value).slice(0, 160));
const count = z.number().int().nonnegative().safe();
const numeric = z.number().finite().nonnegative();
const window = z.object({ usedPercent: numeric, windowDurationMins: count.nullable(), resetsAt: count.nullable() });
const credits = z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().regex(/^\d+(?:\.\d+)?$/).max(64).nullable() });
const rateLimit = z.object({
  limitId: text.nullable(), limitName: text.nullable(), normalModelSlug: text.nullable(),
  primary: window.nullable(), secondary: window.nullable(), credits: credits.nullable(),
  spendControlReached: z.boolean().nullable(), planType: text.nullable(), rateLimitReachedType: text.nullable(),
});
const resetCredit = z.object({ resetType: text, status: text, grantedAt: count, expiresAt: count.nullable() });
const usageSummary = z.object({
  lifetimeTokens: count.nullable(), peakDailyTokens: count.nullable(), longestRunningTurnSec: count.nullable(),
  currentStreakDays: count.nullable(), longestStreakDays: count.nullable(),
});
const dailyBucket = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: count });
const profile = z.object({ id: text, allowed: z.boolean() });
const feature = z.object({ name: text, stage: z.enum(["beta", "underDevelopment", "stable", "deprecated", "removed"]), enabled: z.boolean(), defaultEnabled: z.boolean() });
const skill = z.object({ name: text, scope: text, enabled: z.boolean() });
const hook = z.object({ eventName: text, handlerType: z.enum(["command", "mcpTool", "prompt", "agent"]), enabled: z.boolean(), isManaged: z.boolean(), trustStatus: z.enum(["managed", "untrusted", "trusted", "modified"]) });
const mcp = z.object({
  name: text,
  runtimeStatus: z.enum(["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"]).nullable(),
  authStatus: z.enum(["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
  toolsError: z.unknown().transform((value) => value != null),
}).transform(({ toolsError, ...value }) => ({ ...value, toolDiscoveryFailed: toolsError }));

export type ControlPlaneRead<T> =
  | { status: "available"; data: T; truncated: boolean }
  | { status: "unavailable"; code: "UNSUPPORTED" | "AUTH_UNAVAILABLE" | "BACKEND_UNAVAILABLE" }
  | { status: "error"; code: "INVALID_RESPONSE" };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid response");
  return value;
}

export class ControlPlaneReader {
  constructor(private readonly transport: AppServerTransport) {}

  async usage() {
    const [rateLimits, accountUsage] = await Promise.all([
      this.read("account/rateLimits/read", {}, (raw) => {
        const value = object(raw);
        const buckets = value.rateLimitsByLimitId == null ? null : Object.values(object(value.rateLimitsByLimitId));
        const reset = value.rateLimitResetCredits == null ? null : object(value.rateLimitResetCredits);
        const details = reset?.credits == null ? null : array(reset.credits);
        return { data: {
          ordinaryUsageAllowed: z.boolean().nullable().parse(value.ordinaryUsageAllowed),
          rateLimits: rateLimit.parse(value.rateLimits),
          rateLimitsByLimitId: buckets?.slice(0, 50).map((row) => rateLimit.parse(row)) ?? null,
          rateLimitResetCredits: reset ? { availableCount: count.parse(reset.availableCount), credits: details?.slice(0, 50).map((row) => resetCredit.parse(row)) ?? null } : null,
        }, truncated: (buckets?.length ?? 0) > 50 || (details?.length ?? 0) > 50 };
      }),
      this.read("account/usage/read", {}, (raw) => {
        const value = object(raw);
        const buckets = value.dailyUsageBuckets == null ? null : array(value.dailyUsageBuckets);
        return { data: { summary: usageSummary.parse(value.summary), dailyUsageBuckets: buckets?.slice(0, 90).map((row) => dailyBucket.parse(row)) ?? null }, truncated: (buckets?.length ?? 0) > 90 };
      }),
    ]);
    return { protocolVersion: "0.154.0", fetchedAt: new Date().toISOString(), rateLimits, accountUsage };
  }

  async runtime(cwd: string) {
    const [server, permissionProfiles, windowsSandbox, modelProvider, experimentalFeatures] = await Promise.all([
      this.read("server/diagnostics", {}, (raw) => {
        const value = object(raw);
        const gauges = array(value.gauges);
        return { data: {
          process: z.object({ residentMemoryBytes: count.nullable(), physicalFootprintBytes: count.nullable() }).parse(value.process),
          gauges: gauges.slice(0, 100).map((row) => z.object({ name: text, value: z.number().finite() }).parse(row)),
        }, truncated: gauges.length > 100 };
      }),
      this.page("permissionProfile/list", { cwd }, profile),
      this.read("windowsSandbox/readiness", {}, (raw) => ({ data: z.object({ status: z.enum(["ready", "notConfigured", "updateRequired"]) }).parse(raw), truncated: false })),
      this.read("modelProvider/capabilities/read", {}, (raw) => ({ data: z.object({ namespaceTools: z.boolean(), imageGeneration: z.boolean(), webSearch: z.boolean() }).parse(raw), truncated: false })),
      this.page("experimentalFeature/list", {}, feature),
    ]);
    return { protocolVersion: "0.154.0", fetchedAt: new Date().toISOString(), server, permissionProfiles, windowsSandbox, modelProvider, experimentalFeatures };
  }

  async inventory(cwd: string, kind: "all" | "skills" | "hooks" | "mcp" = "all") {
    const [skills, hooks, mcpServers] = await Promise.all([
      kind === "all" || kind === "skills" ? this.inventoryEntries("skills/list", cwd, "skills", skill) : undefined,
      kind === "all" || kind === "hooks" ? this.inventoryEntries("hooks/list", cwd, "hooks", hook) : undefined,
      kind === "all" || kind === "mcp" ? this.page("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }, mcp) : undefined,
    ]);
    return { protocolVersion: "0.154.0", fetchedAt: new Date().toISOString(), skills, hooks, mcpServers };
  }

  private inventoryEntries<T>(method: "skills/list" | "hooks/list", cwd: string, field: "skills" | "hooks", schema: z.ZodType<T, z.ZodTypeDef, any>) {
    return this.read(method, { cwds: [cwd], ...(method === "skills/list" ? { forceReload: false } : {}) }, (raw) => {
      const entries = array(object(raw).data);
      if (entries.length !== 1 || object(entries[0]).cwd !== cwd) throw new TypeError("Unexpected project inventory");
      const entry = object(entries[0]);
      const rows = array(entry[field]);
      const errors = array(entry.errors);
      const warnings = field === "hooks" ? array(entry.warnings) : [];
      return { data: { items: rows.slice(0, 100).map((row) => schema.parse(row)), errorCount: errors.length, warningCount: warnings.length }, truncated: rows.length > 100 };
    });
  }

  // A single bounded page is intentional: no opaque backend cursors leave the Bridge.
  private page<T>(method: "permissionProfile/list" | "experimentalFeature/list" | "mcpServerStatus/list", params: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, any>) {
    return this.read(method, { ...params, limit: 100 }, (raw) => {
      const value = object(raw);
      const rows = array(value.data);
      const cursor = z.string().nullable().parse(value.nextCursor);
      return { data: rows.slice(0, 100).map((row) => schema.parse(row)), truncated: Boolean(cursor) || rows.length > 100 };
    });
  }

  private async read<T>(method: string, params: Record<string, unknown>, normalize: (value: unknown) => { data: T; truncated: boolean }): Promise<ControlPlaneRead<T>> {
    let raw: unknown;
    try { raw = await this.transport.request(method, params); }
    catch (error) {
      // Inspect only for classification. Never return the backend message or error.data.
      const message = error instanceof Error ? error.message : "";
      const code = /method not found|unknown (?:method|variant)|unsupported|not supported/i.test(message) ? "UNSUPPORTED"
        : /auth|log.?in|sign.?in|401|403|chatgpt account/i.test(message) ? "AUTH_UNAVAILABLE" : "BACKEND_UNAVAILABLE";
      return { status: "unavailable", code };
    }
    try { return { status: "available", ...normalize(raw) }; }
    catch { return { status: "error", code: "INVALID_RESPONSE" }; }
  }
}

const breakdown = z.object({ totalTokens: count, inputTokens: count, cachedInputTokens: count, cacheWriteInputTokens: count, outputTokens: count, reasoningOutputTokens: count });
export const threadTokenUsageSchema = z.object({ total: breakdown, last: breakdown, modelContextWindow: count.nullable() });
export const modelRerouteSchema = z.object({ fromModel: text, toModel: text, reason: z.literal("highRiskCyberActivity") });
export type ThreadTokenUsage = z.infer<typeof threadTokenUsageSchema>;
export type ModelReroute = z.infer<typeof modelRerouteSchema>;
