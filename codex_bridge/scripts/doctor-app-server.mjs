import { CodexAppServerClient } from "../dist/src/app-server-client.js";
import { fileURLToPath } from "node:url";

const projectPath = process.argv[2] || process.cwd();
const client = new CodexAppServerClient({
  command: process.execPath,
  args: [fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url)), "app-server"],
  requestTimeoutMs: 20_000,
});

client.on("stderr", () => undefined);

try {
  await client.ensureStarted();
  const [profiles, models] = await Promise.all([
    client.request("permissionProfile/list", { cwd: projectPath, limit: 100 }),
    client.request("model/list", { limit: 100 }),
  ]);
  console.log(JSON.stringify({ ok: true, projectPath, profiles, models }, null, 2));
} finally {
  await client.close();
}
