import { loadConfig } from "./config.js";
import { startHttpServer } from "./http-server.js";
try {
  const server = await startHttpServer(loadConfig());
  console.error(`listening_audio listening at ${server.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
} catch { console.error("listening_audio startup failed; check config and port ownership."); process.exitCode = 1; }
