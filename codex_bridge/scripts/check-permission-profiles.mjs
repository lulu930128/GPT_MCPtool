// Offline schema/config checks only. No thread, turn, sandbox helper or credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../dist/src/app-server-client.js";
import { loadBridgeConfig } from "../dist/src/config.js";

assert.equal(process.platform, "win32", "This check targets the pinned Windows 0.154.0 binary.");
const component = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = join(component, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const root = await mkdtemp(join(tmpdir(), "bridge-permission-schema-"));
const home = join(root, "home");
const project = join(root, "project");
await mkdir(home);
await mkdir(project);
await writeFile(join(project, "AGENTS.md"), "Synthetic fixture. No real credentials.\n");
await writeFile(join(project, ".env.example"), "EXAMPLE=placeholder\n");
await writeFile(join(project, ".env.local"), "SYNTHETIC=not-a-credential\n");
const deniedNames = [".env.local", ".env.production", ".env.e", ".env.ex", ".env.exampl",
  ".env.example.bak", ".env.examples", ".env.EXAMPLE.UPPER", ".env.exAmple.private", ".env.x"];
for (const name of deniedNames) await writeFile(join(project, name), "SYNTHETIC=not-a-credential\n");
await writeFile(join(project, ".env.EXAMPLE"), "EXAMPLE=placeholder\n");
const projectsFile = join(root, "projects.json");
await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: project }] }));
const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: project,
  CODEX_BRIDGE_PROJECTS_FILE: projectsFile, CODEX_BRIDGE_DATA_DIR: join(root, "state"),
  CODEX_BRIDGE_CODEX_COMMAND: native, CODEX_HOME: home });
const environment = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", USERPROFILE: home, HOME: home,
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  CODEX_HOME: home, TEMP: root, TMP: root, PATH: `${dirname(process.execPath)};C:\\Windows\\System32`,
  PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const version = spawnSync(native, ["--version"], { env: environment, encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0);
assert.match(version.stdout, /\b0\.154\.0\b/);
const schemaDir = join(root, "schema");
const schema = spawnSync(native, ["app-server", "generate-json-schema", "--out", schemaDir, "--experimental"],
  { env: environment, encoding: "utf8", timeout: 15_000 });
assert.equal(schema.status, 0, "Pinned native schema generation failed.");
const startSchema = JSON.parse(await readFile(join(schemaDir, "v2", "ThreadStartResponse.json"), "utf8"));
assert.ok(startSchema.properties.activePermissionProfile);
assert.ok(startSchema.definitions.SandboxPolicy.oneOf.some((entry) =>
  entry.properties?.type?.enum?.includes("readOnly") && entry.properties.networkAccess?.type === "boolean"));

const client = new CodexAppServerClient({ command: native, args: config.codexArgs, environment, requestTimeoutMs: 15_000 });
try {
  await client.ensureStarted();
  const profiles = await client.request("permissionProfile/list", { cwd: project });
  const result = await client.request("config/read", { cwd: project, includeLayers: false });
  for (const [id, parent] of [["codex-bridge-read-only", ":read-only"], ["codex-bridge-workspace", ":workspace"]]) {
    assert.ok(profiles.data.some((profile) => profile.id === id && profile.allowed));
    const profile = result.config.permissions[id];
    assert.equal(profile.extends, parent);
    assert.equal(profile.network.enabled, true);
    assert.equal(profile.filesystem[join(project, ".env")], "deny");
    assert.equal(profile.filesystem[join(project, ".secrets")], "deny");
    assert.equal(profile.filesystem[join(project, ".env.*")], undefined);
    assert.equal(profile.filesystem[join(project, ".tmp", "codex-inbox")], "read");
    const globs = Object.entries(profile.filesystem).filter(([path, access]) => access === "deny" && path.startsWith(join(project, ".env.")))
      .map(([path]) => path.slice(project.length + 1));
    // Use the bundled Rust glob implementation used by the native snapshot scan.
    const listed = spawnSync(join(dirname(dirname(native)), "codex-path", "rg.exe"),
      ["--files", "--hidden", "--no-ignore", "--glob-case-insensitive", ...globs.flatMap((glob) => ["--glob", glob]), "--", project],
      { env: environment, encoding: "utf8", timeout: 15_000 });
    assert.equal(listed.status, 0);
    const names = listed.stdout.trim().split(/\r?\n/).map((path) => path.slice(project.length + 1)).sort();
    assert.deepEqual(names, [...deniedNames].sort());
  }
  console.log(JSON.stringify({ schema: "PASS", profileConfig: "PASS", syntheticDenyGlobScan: "PASS", version: "0.154.0",
    realThreadStarted: false, realTurnStarted: false, planStartup: "UNVERIFIED",
    planHttps: "UNVERIFIED", secretIsolation: "UNVERIFIED" }, null, 2));
} finally {
  await client.close();
}
// Keep the synthetic fixture for inspection; no shared JobStore or runtime state is touched.
