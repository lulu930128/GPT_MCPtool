#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createWorkspaceMcpServer } from "./server.js";
import { segmentedTransfers } from "./segmented-transfer.js";

const config = await loadConfig();
await segmentedTransfers().initialize().catch(() => console.error("Segmented transfer staging unavailable; existing workspace tools remain available."));
const server = createWorkspaceMcpServer(config, { runtimeContext: () => ({ transport: "stdio", httpListening: null }) });
const transport = new StdioServerTransport();
await server.connect(transport);
const closeTransport = transport.onclose;
transport.onclose = () => { closeTransport?.(); void segmentedTransfers().close().catch(() => console.error("Transfer shutdown cleanup incomplete.")); };
