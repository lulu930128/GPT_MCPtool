import { loadConfig } from "./config.js";
import { startJapaneseStudyHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startJapaneseStudyHttpServer(config, (message) => console.error(message));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
