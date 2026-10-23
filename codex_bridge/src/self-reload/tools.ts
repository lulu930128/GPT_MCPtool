import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { RELOAD_CONTRACT, ReloadError, type SelfReloadClient } from "./client.js";

export const SELF_RELOAD_URI = "ui://codex-bridge/self-reload-r1.html";
const requestId = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const binary = z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192);

export function registerSelfReloadTools(server: McpServer, client: SelfReloadClient | undefined, html: string): void {
  registerAppResource(server, "self-reload", SELF_RELOAD_URI, {}, async () => ({ contents: [{ uri: SELF_RELOAD_URI,
    mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  const schemas = {
    status: z.object({}).strict(), preview: z.object({}).strict(),
    request: z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/), previewDigest: digest,
      ttlSeconds: z.number().int().min(60).max(1800) }).strict(),
    receipt: z.object({ requestId }).strict(),
    challenge: z.object({ requestId, digest }).strict(),
    approve: z.object({ requestId, digest, assertion: z.object({ credentialId: binary,
      clientDataJSON: binary, authenticatorData: binary, signature: binary }).strict() }).strict(),
  };
  for (const [operation, inputSchema] of Object.entries(schemas)) {
    const write = ["request", "approve"].includes(operation);
    registerAppTool(server, `codex_self_reload_${operation}`, {
      title: `Codex Bridge self reload: ${operation}`,
      description: operation === "request"
        ? "Create a durable, fixed codex_bridge reload_runtime request only when the user explicitly asks. Reuse the exact idempotency key across retries. Does not approve or launch. Requires human app confirmation and independent Control Center owner."
        : `Remote Self-Reload R1 ${operation}. Only codex_bridge reload_runtime; no administrator, shell, OMI, or secrets. Unknown outcomes must never be resent.`,
      annotations: { readOnlyHint: !write, destructiveHint: operation === "approve", idempotentHint: true, openWorldHint: false },
      inputSchema,
      _meta: { ui: { resourceUri: SELF_RELOAD_URI, ...(["challenge", "approve"].includes(operation) ? { visibility: ["app" as const] } : {}) } },
    }, async (args: Record<string, unknown>) => {
      try {
        if (!client) throw new ReloadError("OWNER_UNAVAILABLE");
        const result = await client.call(operation, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const code = error instanceof ReloadError ? error.code : "RELOAD_UNAVAILABLE";
        const result = { contract: RELOAD_CONTRACT,
          ...(code === "OWNER_UNAVAILABLE" ? { deployment: "NOT_DEPLOYED" } : {}), error: { code }, retryAllowed: false };
        return { isError: operation !== "status", content: [{ type: "text" as const, text: code }], structuredContent: result };
      }
    });
  }
}
