#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createWorkspaceMcpServer } from "./server.js";

const config = await loadConfig();
const server = createWorkspaceMcpServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
