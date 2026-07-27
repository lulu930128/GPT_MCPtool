import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import { createWorkspaceMcpServer } from "./server.js";

export interface WorkspaceHttpServerOptions {
  host: string;
  port: number;
  bearerToken?: string;
  log?: (message: string) => void;
}

export interface WorkspaceHttpServerHandle {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startWorkspaceHttpServer(
  config: ServerConfig,
  options: WorkspaceHttpServerOptions,
): Promise<WorkspaceHttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      sendJsonRpcError(res, 400, -32600, "Missing request URL.");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${options.host}:${options.port}`}`);
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "gpt-project-workspace-mcp",
        mode: "read-only",
        defaultRoot: config.defaultRootId,
        rootIds: Array.from(config.roots.keys()),
        assetScopeIds: Array.from(config.assetScopes.keys()),
      });
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
        await handlePost(config, transports, req, res);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        await handleSessionRequest(transports, req, res);
        return;
      }
      sendJsonRpcError(res, 405, -32000, "Method not allowed.");
    } catch (error) {
      console.error("Error handling MCP HTTP request:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error.");
      }
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
  options.log?.(`GPT Project Workspace MCP HTTP listening at ${url}`);
  if (!options.bearerToken) {
    options.log?.("WARNING: WORKSPACE_MCP_HTTP_TOKEN is not set. Use only behind Secure MCP Tunnel or trusted localhost.");
  }

  return {
    host: options.host,
    port: actualPort,
    url,
    close: async () => {
      await Promise.all(
        Array.from(transports.values()).map((transport) =>
          transport.close().catch((error: unknown) => {
            console.error("Error closing MCP transport:", error);
          }),
        ),
      );
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function parseHttpPort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 65536 ? parsed : fallback;
}

async function handlePost(
  config: ServerConfig,
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

    const mcpServer = createWorkspaceMcpServer(config);
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
    if (totalBytes > 1_048_576) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const authorization = getSingleHeader(req, "authorization");
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
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
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
