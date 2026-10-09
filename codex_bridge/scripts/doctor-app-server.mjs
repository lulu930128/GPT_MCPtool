import { CodexAppServerClient } from "../dist/src/app-server-client.js";
import { loadBridgeConfig } from "../dist/src/config.js";
import { ControlPlaneReader } from "../dist/src/control-plane.js";

const projectPath = process.argv[2] || process.cwd();
const config = await loadBridgeConfig(process.env);
const client = new CodexAppServerClient({
  command: config.codexCommand,
  args: config.codexArgs,
  requestTimeoutMs: 20_000,
});

const diagnostics = [];
client.on("stderr", (line) => diagnostics.push(String(line).slice(0, 2_000)));

async function readPages(method, params) {
  const data = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await client.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error(`${method}: invalid response`);
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error(`${method}: incomplete pagination`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}

try {
  await client.ensureStarted();
  const [profiles, models] = await Promise.all([
    readPages("permissionProfile/list", { cwd: projectPath }),
    readPages("model/list", { includeHidden: false }),
  ]);
  for (const id of ["codex-bridge-read-only", "codex-bridge-workspace"]) {
    if (!profiles.some((profile) => profile.id === id && profile.allowed)) throw new Error(`Missing allowed profile: ${id}`);
  }
  const reader = new ControlPlaneReader(client);
  const [runtime, usage, inventory] = await Promise.all([reader.runtime(projectPath), reader.usage(), reader.inventory(projectPath)]);
  const statuses = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item === "object" && "status" in item)
    .map(([name, item]) => [name, { status: item.status, ...(item.code ? { code: item.code } : {}), ...(item.status === "available" ? { truncated: item.truncated } : {}) }]));
  const controlPlane = { runtime: statuses(runtime), usage: statuses(usage), inventory: statuses(inventory) };
  if ([runtime, usage, inventory].some((group) => Object.values(group).some((item) => item?.status === "error"))) {
    console.error(JSON.stringify({ ok: false, controlPlane }));
    throw new Error("Control-plane protocol normalization failed.");
  }
  console.log(JSON.stringify({ ok: true, verification: "isolated-read-only-capabilities", realTurnStarted: false,
    controlPlane,
    profiles: profiles.filter((profile) => profile.id.startsWith("codex-bridge-")).map(({ id, allowed }) => ({ id, allowed })),
    models: models.map((model) => ({ id: model.id, isDefault: model.isDefault, efforts: model.supportedReasoningEfforts?.map((option) => option.reasoningEffort) })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: "Isolated App Server capability checks failed.",
    diagnosticLineCount: diagnostics.length,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close();
}
