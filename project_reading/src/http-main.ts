#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { parseHttpPort, startWorkspaceHttpServer } from "./http-server.js";
import { segmentedTransfers } from "./segmented-transfer.js";

const config = await loadConfig();
// Recover owned transfer staging before accepting requests; a transfer failure does not disable legacy tools.
await segmentedTransfers().initialize().catch(() => console.error("Segmented transfer staging unavailable; existing workspace tools remain available."));
const handle = await startWorkspaceHttpServer(config, {
  host: process.env.WORKSPACE_MCP_HTTP_HOST?.trim() || "127.0.0.1",
  port: parseHttpPort(process.env.WORKSPACE_MCP_HTTP_PORT, 18787),
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
  await segmentedTransfers().close();
  process.exit(0);
}
