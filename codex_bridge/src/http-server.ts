import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeRuntime } from "./runtime.js";
import { createCodexBridgeMcpServer } from "./server.js";

export interface BridgeHttpServerOptions {
  host: string;
  port: number;
  bearerToken?: string;
  log?: (message: string) => void;
}

export interface BridgeHttpServerHandle {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startBridgeHttpServer(
  runtime: BridgeRuntime,
  options: BridgeHttpServerOptions,
): Promise<BridgeHttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      sendJsonRpcError(res, 400, -32600, "Missing request URL.");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || `${options.host}:${options.port}`}`);
    setCorsHeaders(res);
    if (req.method === "OPTIONS" && url.pathname === "/mcp") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, healthPayload(runtime));
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { ok: false, error: "Not found." });
      return;
    }
    if (!isAuthorized(req, options.bearerToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    try {
      if (req.method === "POST") {
        await handlePost(runtime, transports, req, res);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        await handleSessionRequest(transports, req, res);
        return;
      }
      sendJsonRpcError(res, 405, -32000, "Method not allowed.");
    } catch (error) {
      options.log?.(`MCP HTTP error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}/mcp`;
  options.log?.(`Codex Handoff Bridge listening at ${url}`);
  if (!options.bearerToken) {
    options.log?.("WARNING: no HTTP bearer token is configured; keep the listener on localhost behind the secure tunnel.");
  }
  return {
    host: options.host,
    port: actualPort,
    url,
    close: async () => {
      await Promise.all(Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)));
      transports.clear();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await runtime.close();
    },
  };
}

function healthPayload(runtime: BridgeRuntime) {
  const jobs = runtime.store.list(runtime.config.maxRecentJobs);
  return {
    ok: true,
    service: "codex-handoff-bridge",
    version: "1.1.0",
    buildId: runtime.config.buildId,
    controller: runtime.controller.status,
    projectIds: Array.from(runtime.config.projects.keys()),
    jobs: {
      totalVisible: jobs.length,
      active: jobs.filter((job) => ["queued", "preparing", "running", "awaiting_approval"].includes(job.status)).length,
      awaitingApproval: jobs.filter((job) => job.status === "awaiting_approval").length,
    },
  };
}

async function handlePost(
  runtime: BridgeRuntime,
  transports: Map<string, StreamableHTTPServerTransport>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = getSingleHeader(req, "mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    if (sessionId || !isInitializeRequest(body)) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: no valid MCP session ID provided.");
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedSessionId) => {
        if (transport) transports.set(initializedSessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) transports.delete(transport.sessionId);
    };
    const server = createCodexBridgeMcpServer(runtime);
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, body);
}

async function handleSessionRequest(
  transports: Map<string, StreamableHTTPServerTransport>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = getSingleHeader(req, "mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!sessionId || !transport) {
    sendJsonRpcError(res, 400, -32000, "Invalid or missing MCP session ID.");
    return;
  }
  await transport.handleRequest(req, res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 2_097_152) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const authorization = getSingleHeader(req, "authorization");
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!candidate) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function getSingleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
