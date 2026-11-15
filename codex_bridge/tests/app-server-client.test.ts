import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server-client.js";

test("App Server version comes from each initialize handshake and clears on close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-handshake-test-"));
  const script = join(root, "server.mjs");
  const agentFile = join(root, "agent.txt");
  await writeFile(script, `import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id) console.log(JSON.stringify({ id: message.id, result: message.method === "initialize"
    ? { userAgent: readFileSync(process.argv[2], "utf8"), codexHome: "private-home" } : {} }));
});`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [script, agentFile], requestTimeoutMs: 5000 });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(client.protocolVersion, null);
  for (const [agent, expected] of [
    ["codex-handoff-bridge/0.165.0 (Windows; private-host) unknown", "0.165.0"],
    ["codex-handoff-bridge/1.0.0 (Windows)", "1.0.0"],
    ["unrecognized/private-host", null],
    ["codex-handoff-bridge/0.165.0/private-host", null],
  ] as const) {
    await writeFile(agentFile, agent);
    await client.ensureStarted();
    assert.equal(client.status, "ready");
    assert.equal(client.protocolVersion, expected);
    await client.request("fixture/read");
    await client.close();
    assert.equal(client.protocolVersion, null);
  }
});
