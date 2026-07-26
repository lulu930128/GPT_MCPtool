import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { JapaneseStudyMcpConfig } from "./config.js";
import { createJapaneseStudyMcpServer } from "./server.js";

export interface JapaneseStudyHttpServerHandle {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startJapaneseStudyHttpServer(
  config: JapaneseStudyMcpConfig,
  log: (message: string) => void = () => undefined,
): Promise<JapaneseStudyHttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      sendJsonRpcError(res, 400, -32600, "Missing request URL.");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "japanese-study-mcp",
        version: "0.1.0",
        archetype: "tool-only",
        hub: config.hubBaseUrl,
        auth: config.httpToken ? "bearer" : "loopback-only",
      });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { ok: false, error: "Not found." });
      return;
    }
    if (!isAuthorized(req, config.httpToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    try {
      if (req.method === "POST") {
        await handlePost(config, transports, req, res);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        await handleSessionRequest(transports, req, res);
        return;
      }
      sendJsonRpcError(res, 405, -32000, "Method not allowed.");
    } catch (error) {
      console.error("Japanese Study MCP request failed:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error.");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${config.host}:${actualPort}/mcp`;
  log(`Japanese Study MCP listening at ${url}`);
  if (!config.httpToken) {
    log("MCP bearer token is not set; listener is restricted to loopback configuration.");
  }

  return {
    host: config.host,
    port: actualPort,
    url,
    close: async () => {
      await Promise.all(
        Array.from(transports.values()).map((transport) => transport.close().catch(() => undefined)),
      );
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handlePost(
  config: JapaneseStudyMcpConfig,
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
        if (transport) {
          transports.set(initializedSessionId, transport);
        }
      },
    });
    transport.onclose = () => {
      const initializedSessionId = transport?.sessionId;
      if (initializedSessionId) {
        transports.delete(initializedSessionId);
      }
    };
    const mcpServer = createJapaneseStudyMcpServer(config);
    await mcpServer.connect(transport);
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
    if (totalBytes > 524_288) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const authorization = getSingleHeader(req, "authorization");
  const candidate = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!candidate) {
    return false;
  }
  const expectedBytes = Buffer.from(token);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}

function getSingleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
