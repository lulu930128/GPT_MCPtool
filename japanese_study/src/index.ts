import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createJapaneseStudyMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createJapaneseStudyMcpServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
