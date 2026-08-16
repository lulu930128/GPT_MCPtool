import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { EnglishStudyMcpConfig } from "./config.js";
import { createEnglishStudyMcpServer, ENGLISH_STUDY_CONTRACT_VERSION, ENGLISH_STUDY_MCP_VERSION, ENGLISH_STUDY_TOOL_COUNT } from "./server.js";

const BUILD_ID = computeBuildId();
export interface HttpServerHandle { host: string; port: number; url: string; close: () => Promise<void>; }

export async function startEnglishStudyHttpServer(config: EnglishStudyMcpConfig, log: (message: string) => void = () => undefined): Promise<HttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    if (!req.url) return sendJsonRpcError(res, 400, -32600, "Missing request URL.");
    const url = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "english-study-mcp", version: ENGLISH_STUDY_MCP_VERSION, contractVersion: ENGLISH_STUDY_CONTRACT_VERSION, buildId: BUILD_ID, toolCount: ENGLISH_STUDY_TOOL_COUNT, archetype: "tool-only", hub: config.hubBaseUrl, auth: config.httpToken ? "bearer" : "loopback-only" });
    }
    if (url.pathname !== "/mcp") return sendJson(res, 404, { ok: false, error: "Not found." });
    if (!isAuthorized(req, config.httpToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendJson(res, 401, { ok: false, error: "Unauthorized." });
    }
    try {
      if (req.method === "POST") return await handlePost(config, transports, req, res);
      if (req.method === "GET" || req.method === "DELETE") return await handleSessionRequest(transports, req, res);
      return sendJsonRpcError(res, 405, -32000, "Method not allowed.");
    } catch (error) {
      console.error("English Study MCP request failed:", error);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => { httpServer.off("error", reject); resolve(); });
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${config.host}:${actualPort}/mcp`;
  log(`English Study MCP listening at ${url}`);
  return { host: config.host, port: actualPort, url, close: async () => {
    await Promise.all(Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)));
    transports.clear();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  } };
}

async function handlePost(config: EnglishStudyMcpConfig, transports: Map<string, StreamableHTTPServerTransport>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = getSingleHeader(req, "mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    if (sessionId || !isInitializeRequest(body)) return sendJsonRpcError(res, 400, -32000, "Bad Request: no valid MCP session ID provided.");
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { if (transport) transports.set(id, transport); } });
    transport.onclose = () => { const id = transport?.sessionId; if (id) transports.delete(id); };
    await createEnglishStudyMcpServer(config).connect(transport);
  }
  await transport.handleRequest(req, res, body);
}

async function handleSessionRequest(transports: Map<string, StreamableHTTPServerTransport>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = getSingleHeader(req, "mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!sessionId || !transport) return sendJsonRpcError(res, 400, -32000, "Invalid or missing MCP session ID.");
  await transport.handleRequest(req, res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 524_288) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const value = getSingleHeader(req, "authorization");
  const candidate = value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
  if (!candidate) return false;
  const expected = Buffer.from(token); const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function getSingleHeader(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; }
function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void { sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }); }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
function computeBuildId(): string {
  try {
    const hashes = ["./api-client.js", "./config.js", "./http-server.js", "./server.js"].map((artifact) => createHash("sha256").update(readFileSync(new URL(artifact, import.meta.url))).digest("hex"));
    return createHash("sha256").update(hashes.join(""), "utf8").digest("hex").slice(0, 16);
  } catch { return "unavailable"; }
}
