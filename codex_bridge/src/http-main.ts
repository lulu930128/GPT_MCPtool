import { loadBridgeConfig } from "./config.js";
import { startBridgeHttpServer } from "./http-server.js";
import { createBridgeRuntime } from "./runtime.js";
import { closeResources, waitForClose } from "./close-resources.js";
import type { BridgeRuntime } from "./runtime.js";
import type { BridgeHttpServerOptions } from "./http-server.js";
import { pathToFileURL } from "node:url";
import { startCooperativeShutdown } from "./cooperative-shutdown.js";
import { currentProcessIdentity } from "./process-identity.js";

export async function startRuntimeHttp(runtime: BridgeRuntime, options: BridgeHttpServerOptions) {
  try { return await startBridgeHttpServer(runtime, options); }
  catch (error) {
    await closeResources([() => { throw error; }, () => waitForClose(runtime.close(), 10000, "RUNTIME_CLOSE_UNKNOWN")]);
    throw error;
  }
}

async function main(): Promise<void> {
  const config = await loadBridgeConfig();
  await currentProcessIdentity();
  const runtime = await createBridgeRuntime(config);
  const handle = await startRuntimeHttp(runtime, {
    host: config.httpHost,
    port: config.httpPort,
    bearerToken: config.httpToken,
    deferAdmission: true,
    log: (message) => console.error(message),
  });

  let cooperative: ReturnType<typeof startCooperativeShutdown> | undefined;
  try {
    cooperative = startCooperativeShutdown(runtime, handle);
    await cooperative.ready;
    handle.activate();
  } catch (error) {
    await closeResources([() => { throw error; }, () => handle.close(), () => cooperative?.close()]);
    throw error;
  }
  const shutdown = () => {
    void closeResources([() => handle.close(), () => cooperative.close()]).then(() => { process.exitCode = 0; }, () => {
      console.error("RUNTIME_CLOSE_FAILED"); process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
