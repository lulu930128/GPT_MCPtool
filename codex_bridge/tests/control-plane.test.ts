import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneReader } from "../src/control-plane.js";
import type { AppServerTransport } from "../src/app-server-client.js";

function fixture(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const reader = new ControlPlaneReader({ request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    const response = responses[method];
    if (response instanceof Error) throw response;
    return response;
  } } as AppServerTransport);
  return { reader, calls };
}

const rate = { limitId: "codex", limitName: "Codex", normalModelSlug: null,
  primary: { usedPercent: 48, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "5.25" }, spendControlReached: null, planType: "pro", rateLimitReachedType: null };
const summary = { lifetimeTokens: null, peakDailyTokens: 123, longestRunningTurnSec: 60, currentStreakDays: null, longestStreakDays: 4 };

test("usage selects 0.154.0 fields, retains null and bounds buckets/credits without raw account metadata", async () => {
  const { reader, calls } = fixture({
    "account/rateLimits/read": { ordinaryUsageAllowed: null, rateLimits: rate, rateLimitsByLimitId: { codex: rate }, accountId: "private-account", rateLimitUpsell: { token: "private-token" },
      rateLimitResetCredits: { availableCount: 80, credits: Array.from({ length: 80 }, () => ({ id: "private-credit", resetType: "primary", status: "available", grantedAt: 20, expiresAt: null })) } },
    "account/usage/read": { summary, dailyUsageBuckets: Array.from({ length: 95 }, () => ({ startDate: "2026-10-08", tokens: 12 })), auth: "secret" },
  });
  const result = await reader.usage();
  assert.equal(result.rateLimits.status, "available");
  if (result.rateLimits.status !== "available" || result.accountUsage.status !== "available") throw new Error("Expected usage");
  assert.equal(result.rateLimits.data.ordinaryUsageAllowed, null);
  assert.equal(result.rateLimits.data.rateLimits.primary?.resetsAt, 1800000000);
  assert.equal(result.rateLimits.data.rateLimits.credits?.balance, "5.25");
  assert.equal(result.rateLimits.data.rateLimitResetCredits?.credits?.length, 50);
  assert.equal(result.rateLimits.truncated, true);
  assert.equal(result.accountUsage.data.summary.lifetimeTokens, null);
  assert.equal(result.accountUsage.data.dailyUsageBuckets?.length, 90);
  assert.equal(result.accountUsage.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /private-|secret/);
  assert.deepEqual(calls.map((call) => call.params), [{}, {}]);
});

test("usage failures, unsupported auth and invalid/unsafe integers never become zero", async () => {
  const { reader } = fixture({ "account/rateLimits/read": new Error("Method not found Bearer private-secret"), "account/usage/read": new Error("Requires ChatGPT account private-account") });
  const result = await reader.usage();
  assert.deepEqual(result.rateLimits, { status: "unavailable", code: "UNSUPPORTED" });
  assert.deepEqual(result.accountUsage, { status: "unavailable", code: "AUTH_UNAVAILABLE" });
  assert.doesNotMatch(JSON.stringify(result), /private/);
  for (const value of [{}, { summary: { ...summary, lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 }, dailyUsageBuckets: null }]) {
    assert.deepEqual((await fixture({ "account/usage/read": value }).reader.usage()).accountUsage, { status: "error", code: "INVALID_RESPONSE" });
  }
  const empty = await fixture({ "account/usage/read": { summary, dailyUsageBuckets: null } }).reader.usage();
  assert.equal(empty.accountUsage.status === "available" && empty.accountUsage.data.dailyUsageBuckets, null);
});

test("runtime diagnostics isolate failures, select safe capabilities and disclose incomplete inventory", async () => {
  const { reader, calls } = fixture({
    "server/diagnostics": { process: { id: 123, residentMemoryBytes: 1024, physicalFootprintBytes: null, path: "private-path" }, gauges: [{ name: "threads", value: 2 }] },
    "permissionProfile/list": { data: [{ id: "read-only", allowed: true, description: "private-path" }], nextCursor: "private-cursor" },
    "windowsSandbox/readiness": new Error("unsupported platform"),
    "modelProvider/capabilities/read": { namespaceTools: true, imageGeneration: false, webSearch: true, token: "private-token" },
    "experimentalFeature/list": { data: [{ name: "feature", stage: "beta", enabled: false, defaultEnabled: false, description: "private" }], nextCursor: null },
  });
  const result = await reader.runtime("configured-project");
  assert.equal(result.server.status, "available");
  assert.equal(result.windowsSandbox.status, "unavailable");
  assert.equal(result.permissionProfiles.status === "available" && result.permissionProfiles.truncated, true);
  assert.equal(result.modelProvider.status, "available");
  assert.equal(result.experimentalFeatures.status, "available");
  assert.doesNotMatch(JSON.stringify(result), /private|configured-project/);
  assert.deepEqual(calls.find((call) => call.method === "permissionProfile/list")?.params, { cwd: "configured-project", limit: 100 });
});

test("skills/hooks/MCP inventory never returns paths, commands, schemas, raw auth or errors", async () => {
  const { reader, calls } = fixture({
    "skills/list": { data: [{ cwd: "configured", skills: Array.from({ length: 101 }, () => ({ name: "skill", enabled: true, scope: "user", path: "private-path", description: "private" })), errors: [{ message: "private-error" }] }] },
    "hooks/list": { data: [{ cwd: "configured", hooks: [{ eventName: "SessionStart", handlerType: "command", enabled: true, isManaged: false, trustStatus: "trusted", command: "private-command", sourcePath: "private-path", key: "private" }], warnings: ["private"], errors: [] }] },
    "mcpServerStatus/list": { data: [{ name: "server", runtimeStatus: null, authStatus: "bearerToken", tools: { private: { schema: "private" } }, toolsError: "private-auth-error", resources: ["private-uri"] }], nextCursor: null },
  });
  const result = await reader.inventory("configured");
  assert.equal(result.skills?.status === "available" && result.skills.truncated, true);
  assert.equal(result.hooks?.status === "available" && result.hooks.data.warningCount, 1);
  assert.equal(result.mcpServers?.status === "available" && result.mcpServers.data[0]?.runtimeStatus, null);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.deepEqual(calls.map((call) => call.method), ["skills/list", "hooks/list", "mcpServerStatus/list"]);
  assert.deepEqual(calls[0].params, { cwds: ["configured"], forceReload: false });
  assert.deepEqual(calls[2].params, { detail: "toolsAndAuthOnly", limit: 100 });
  calls.length = 0;
  await reader.inventory("configured", "mcp");
  assert.equal(calls.length, 1);
  assert.equal((await reader.inventory("wrong-project", "skills")).skills?.status, "error");
});
