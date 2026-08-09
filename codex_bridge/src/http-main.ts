import { loadBridgeConfig } from "./config.js";
import { startBridgeHttpServer } from "./http-server.js";
import { createBridgeRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const config = await loadBridgeConfig();
  const runtime = await createBridgeRuntime(config);
  const handle = await startBridgeHttpServer(runtime, {
    host: config.httpHost,
    port: config.httpPort,
    bearerToken: config.httpToken,
    log: (message) => console.error(message),
  });

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
