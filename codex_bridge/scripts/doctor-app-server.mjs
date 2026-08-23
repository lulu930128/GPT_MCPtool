import { CodexAppServerClient } from "../dist/src/app-server-client.js";
import { loadBridgeConfig } from "../dist/src/config.js";

const projectPath = process.argv[2] || process.cwd();
const config = await loadBridgeConfig(process.env);
const client = new CodexAppServerClient({
  command: config.codexCommand,
  args: config.codexArgs,
  requestTimeoutMs: 20_000,
});

const diagnostics = [];
client.on("stderr", (line) => diagnostics.push(String(line).slice(0, 2_000)));

try {
  await client.ensureStarted();
  const [profiles, models] = await Promise.all([
    client.request("permissionProfile/list", { cwd: projectPath, limit: 100 }),
    client.request("model/list", { limit: 100 }),
  ]);
  console.log(JSON.stringify({ ok: true, projectPath, profiles, models }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    diagnostics: diagnostics.slice(-10),
  }, null, 2));
  throw error;
} finally {
  await client.close();
}
