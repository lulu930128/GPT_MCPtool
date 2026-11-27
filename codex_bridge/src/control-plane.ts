import { z } from "zod";
import type { AppServerTransport } from "./app-server-client.js";
import { redactString } from "./redaction.js";

// Audited against the installed @openai/codex 0.165.0 experimental protocol.
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

export const nativeSourceKinds = ["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"];
export type ThreadPageKind = "goal" | "queue" | "search" | "agents" | "messages";

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
    return { protocolVersion: this.transport.protocolVersion ?? null, fetchedAt: new Date().toISOString(), rateLimits, accountUsage };
  }

  permissionProfiles(cwd:string) {
    return this.page("permissionProfile/list",{cwd},profile);
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
      this.permissionProfiles(cwd),
      this.read("windowsSandbox/readiness", {}, (raw) => ({ data: z.object({ status: z.enum(["ready", "notConfigured", "updateRequired"]) }).parse(raw), truncated: false })),
      // 0.165 removed namespaceTools. Preserve older boolean evidence and report
      // unknown when absent; removal does not mean the provider lacks support.
      this.read("modelProvider/capabilities/read", {}, (raw) => ({ data: z.object({ namespaceTools: z.boolean().optional().transform((value) => value ?? null), imageGeneration: z.boolean(), webSearch: z.boolean() }).parse(raw), truncated: false })),
      this.page("experimentalFeature/list", {}, feature),
    ]);
    return { protocolVersion: this.transport.protocolVersion ?? null, fetchedAt: new Date().toISOString(), server, permissionProfiles, windowsSandbox, modelProvider, experimentalFeatures, nativeIdentity:{serverVersion:this.transport.protocolVersion ?? null, source:"initialize.userAgent", wireProtocolVersion:null} };
  }

  async inventory(cwd: string, kind: "all" | "skills" | "hooks" | "mcp" = "all") {
    const [skills, hooks, mcpServers] = await Promise.all([
      kind === "all" || kind === "skills" ? this.inventoryEntries("skills/list", cwd, "skills", skill) : undefined,
      kind === "all" || kind === "hooks" ? this.inventoryEntries("hooks/list", cwd, "hooks", hook) : undefined,
      kind === "all" || kind === "mcp" ? this.page("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }, mcp) : undefined,
    ]);
    return { protocolVersion: this.transport.protocolVersion ?? null, fetchedAt: new Date().toISOString(), skills, hooks, mcpServers };
  }

  async threadPage(threadId: string, kind: ThreadPageKind, cursor?: string, searchTerm?: string) {
    const paging = {limit:100,...(cursor ? {cursor} : {})};
    if (kind === "agents") return this.read("thread/list",{...paging,parentThreadId:threadId,
      sourceKinds:nativeSourceKinds}, raw => {
      const value = z.object({data:z.array(z.object({id:z.string(), parentThreadId:z.literal(threadId),
        agentRole:text.nullable(), agentNickname:text.nullable(),model:text.nullable(),reasoningEffort:text.nullable(),
        status:z.object({type:text})})),nextCursor:z.string().nullable()}).parse(raw);
      return {data:value,truncated:value.nextCursor !== null};
    });
    if (kind === "messages") return this.read("thread/items/list",{...paging,threadId,sortDirection:"desc",
      deferOutput:{commandExecution:true,mcpToolCall:true}},raw => {
      const value = object(raw);
      const data = array(value.data).flatMap(entry => {
        const row = object(entry), item = object(row.item);
        if (item.type !== "agentMessage" && item.type !== "userMessage") return [];
        const message = item.type === "agentMessage" ? z.string().parse(item.text) : array(item.content)
          .map(part => object(part)).filter(part => part.type === "text").map(part => z.string().parse(part.text)).join("\n");
        return [{id:z.string().parse(item.id),turnId:z.string().parse(row.turnId),role:item.type,snippet:redactString(message)}];
      });
      const nextCursor = z.string().nullable().parse(value.nextCursor);
      return {data:{data,nextCursor},truncated:nextCursor !== null};
    });
    if (kind === "goal") return this.read("thread/goal/get", {threadId}, raw => {
      const goal = z.object({threadId:z.literal(threadId), objective:z.string().transform(redactString), status:text,
        tokenBudget:count.nullable(), tokensUsed:count, updatedAt:count}).nullable().parse(object(raw).goal);
      return {data:{goal}, truncated:false};
    });
    const params = {threadId, limit:100, ...(cursor ? {cursor} : {})};
    if (kind === "search") return this.read("thread/searchOccurrences", {...params, searchTerm}, raw => {
      const value = z.object({data:z.array(z.object({turnId:text, itemId:text, snippet:z.string().transform(redactString), turnCursor:z.string()})),
        nextCursor:z.string().nullable()}).parse(raw);
      return {data:value, truncated:value.nextCursor !== null};
    });
    return this.read("thread/queue/list", params, raw => {
      const value = z.object({data:z.array(z.object({id:z.string(), clientUserMessageId:z.string(),
        input:z.array(z.object({type:z.string(),text:z.string().optional()}))})),nextCursor:z.string().nullable()}).parse(raw);
      return {data:{...value, data:value.data.map(row => ({id:row.id,clientUserMessageId:row.clientUserMessageId,
        text:redactString(row.input.map(item => item.type === "text" ? item.text ?? "" : "[" + item.type + "]").join("\n"))}))},truncated:value.nextCursor !== null};
    });
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

  private async page<T>(method: "permissionProfile/list" | "experimentalFeature/list" | "mcpServerStatus/list", params: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<ControlPlaneRead<T[]>> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ControlPlaneRead<{rows:T[]; next:string | null}> = await this.read(method,
        { ...params, limit: 100, ...(cursor === null ? {} : { cursor }) }, raw => {
          const value = object(raw);
          return { data: { rows: array(value.data).map(row => schema.parse(row)), next: z.string().min(1).nullable().parse(value.nextCursor) }, truncated: false };
        });
      if (page.status !== "available") return page;
      items.push(...page.data.rows);
      cursor = page.data.next;
      if (cursor !== null) {
        if (seen.has(cursor)) return { status: "error", code: "INVALID_RESPONSE" };
        seen.add(cursor);
      }
    } while (cursor !== null);
    return { status: "available", data: items, truncated: false };
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
