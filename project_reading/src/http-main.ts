#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { parseHttpPort, startWorkspaceHttpServer } from "./http-server.js";

const config = await loadConfig();
const handle = await startWorkspaceHttpServer(config, {
  host: process.env.WORKSPACE_MCP_HTTP_HOST?.trim() || "127.0.0.1",
  port: parseHttpPort(process.env.WORKSPACE_MCP_HTTP_PORT, 8787),
  bearerToken: process.env.WORKSPACE_MCP_HTTP_TOKEN?.trim() || undefined,
  log: (message) => console.error(message),
});

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  console.error("Shutting down MCP HTTP server...");
  await handle.close();
  process.exit(0);
}
