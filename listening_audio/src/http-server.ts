import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { CONTRACT, VERSION, TOOL_COUNT, createMcpServer } from "./server.js";
export function buildId() {
  const hash = createHash("sha256");
  for (const file of ["config", "errors", "schemas", "trainer-client", "server", "http-server"]) hash.update(readFileSync(new URL(`./${file}.js`, import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data));
}
function authorized(req: IncomingMessage, config: Config) {
  if (!config.token) return true;
  const provided = req.headers.authorization ?? "";
  const expected = `Bearer ${config.token}`;
  return Buffer.byteLength(provided) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
export async function startHttpServer(config: Config) {
  const artifactId = buildId(); let inflight = 0;
  const http = createServer(async (req, res) => {
    // No browser-origin callers in the local tool-only release. Remote authentication is owned by the configured secure tunnel.
    if (req.headers.origin || (!config.token && !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? ""))) {
      json(res, 403, { error: "Origin or Host rejected." }); return;
    }
    if (!authorized(req, config)) { res.setHeader("www-authenticate", "Bearer"); json(res, 401, { error: "Unauthorized." }); return; }
    if (req.url === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, service: "listening-audio-mcp", version: VERSION, contractVersion: CONTRACT,
        buildId: artifactId, toolCount: TOOL_COUNT, languages: ["ja"], transport: "streamable-http-stateless",
        auth: config.token ? "bearer" : "loopback-only", trainer: { state: "not_probed", probeTool: "listening_health" }, tunnelConfigured: process.env.LISTENING_TUNNEL_CONFIGURED === "1" }); return;
    }
    if (req.url !== "/mcp") { json(res, 404, { error: "Not found." }); return; }
    if (req.method !== "POST") { res.setHeader("allow", "POST"); json(res, 405, { error: "Method not allowed." }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { json(res, 415, { error: "JSON required." }); return; }
    if (inflight >= 16) { json(res, 503, { error: "Busy." }); return; }
    inflight++;
    try {
      if (Number(req.headers["content-length"]) > 300000) { json(res, 413, { error: "Request too large." }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 300000) { json(res, 413, { error: "Request too large." }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json(res, 400, { error: "Invalid JSON." }); return; }
      const server = createMcpServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try { await server.connect(transport); await transport.handleRequest(req, res, body); }
      finally { await server.close(); }
    } catch {
      console.error("listening_audio: HTTP request failed.");
      if (!res.headersSent) json(res, 500, { error: "Internal error." });
    } finally { inflight--; }
  });
  http.requestTimeout = 15000; http.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(config.port, config.host, () => { http.off("error", reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Listener unavailable.");
  return { url: `http://${config.host}:${address.port}/mcp`, port: address.port,
    close: () => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeIdleConnections(); }) };
}
