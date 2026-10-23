import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { loadBridgeConfig, resolveInstalledCodexLaunch } from "../src/config.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { assertInstalledEnvironment, hasInstalledLayout, installedCodexEnvironment, loadInstalledBinding, parseInstalledBinding, type InstalledBridgeBinding } from "../src/installed-runtime.js";

function bindingFixture(): InstalledBridgeBinding {
  const releaseRoot = "C:\\Program Files\\McpCcReleases\\release-a";
  const codeRoot = win32.join(releaseRoot, "codex_bridge");
  const configRoot = "C:\\fixture-workspace\\codex_bridge";
  const localAppData = "C:\\fixture-user\\AppData\\Local";
  const ownerRoot = win32.join(localAppData, "McpControlCenter");
  return { contract: "codex-bridge-installed-binding-v1", releaseId: "release-a", releaseRoot, codeRoot, configRoot,
    runtimeRoot: win32.join(ownerRoot, "installed-bridge", "release-a"), ownerRoot,
    projectsFile: win32.join(configRoot, ".local", "projects.json"), dataDir: "C:\\fixture-data", codexHome: "C:\\fixture-user\\.codex",
    handoffDir: win32.join(configRoot, ".tmp", "codex-inbox"), operatorSid: "S-1-5-21-100-200-300-1001",
    userProfile: "C:\\fixture-user", localAppData, windowsRoot: "C:\\Windows",
    nodePath: win32.join(releaseRoot, "dependencies", "node", "node.exe"),
    tunnelClientPath: win32.join(releaseRoot, "dependencies", "tunnel-client", "tunnel-client.exe"),
    keyStorePath: win32.join(releaseRoot, "dependencies", "key-store", "key-store.ps1"),
    codexLauncher: win32.join(codeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
    codexNative: win32.join(codeRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    tunnelProfileDir: win32.join(configRoot, ".tunnel-client"),
    secretPath: "C:\\fixture-workspace\\project_reading\\.secrets\\control-plane-api-key.dpapi",
    activationReady: false, blocker: "INSTALLED_LIFECYCLE_BINDINGS_REQUIRED" };
}

test("installed binding parser keeps executable closure and code/state paths exact; it is not an activation grant", () => {
  const fixture = bindingFixture();
  const binding = parseInstalledBinding(JSON.stringify(fixture), fixture.codeRoot, fixture.nodePath);
  assert.deepEqual(binding, fixture);
  assert.ok(Object.isFrozen(binding));
  assert.throws(() => parseInstalledBinding(JSON.stringify(fixture), fixture.configRoot, fixture.nodePath), /INSTALLED_BINDING_MISMATCH/);
  assert.throws(() => parseInstalledBinding(JSON.stringify(fixture), fixture.codeRoot, "C:\\untrusted\\node.exe"), /INSTALLED_BINDING_MISMATCH/);
  for (const patch of [
    { nodePath: "C:\\untrusted\\node.exe" }, { codexLauncher: "C:\\untrusted\\codex.js" },
    { codexNative: "C:\\untrusted\\codex.exe" }, { keyStorePath: "C:\\untrusted\\key-store.ps1" },
    { tunnelClientPath: "C:\\untrusted\\tunnel-client.exe" }, { runtimeRoot: win32.join(fixture.codeRoot, ".tmp") },
    { handoffDir: win32.join(fixture.codeRoot, ".tmp", "codex-inbox") },
    { dataDir: fixture.codeRoot }, { projectsFile: "C:\\data\\..\\escape" },
    { dataDir: "C:\\data:stream" }, { dataDir: "\\\\server\\share" },
    { activationReady: true }, { unknown: true }, { windowsRoot: "C:\\untrusted" },
  ]) assert.throws(() => parseInstalledBinding(JSON.stringify({ ...fixture, ...patch }), fixture.codeRoot, fixture.nodePath), /INSTALLED_/);
  assert.throws(() => parseInstalledBinding(" ".repeat(16385), fixture.codeRoot, fixture.nodePath), /INSTALLED_BINDING_LIMIT/);
});

test("installed Full Access default retains plan and rollback sandbox definitions", () => {
  const binding = bindingFixture();
  const launch = resolveInstalledCodexLaunch(binding, ["C:\\fixture-workspace"]);
  assert.equal(launch.command, binding.nodePath);
  assert.ok(launch.args.includes('default_permissions=":danger-full-access"'));
  assert.deepEqual(launch.args.slice(0, 2), [binding.codexLauncher, "app-server"]);
  assert.ok(!launch.args.some((arg) => /--(require|import|loader)|cmd\.exe|powershell/i.test(arg)));
  for (const name of ["read-only", "workspace"]) {
    const profile = launch.args.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    for (const path of [binding.releaseRoot, binding.ownerRoot, binding.runtimeRoot, binding.projectsFile, binding.dataDir,
      win32.join(binding.configRoot, ".local"), win32.join(binding.configRoot, ".secrets"), win32.join(binding.configRoot, ".tunnel-client"),
      win32.dirname(binding.secretPath)]) assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`), path);
    assert.ok(profile.includes(`${JSON.stringify(binding.handoffDir)} = "read"`));
  }
  // Codex profiles do not prove a different plugin's or the OS's effective write denial.
  assert.equal(binding.activationReady, false);
});

test("v2 binding pins private deployment snapshots and preserves the canonical store and shared home", () => {
  const legacy = bindingFixture();
  const deployment = win32.join(legacy.runtimeRoot, "deployment");
  const fixture: InstalledBridgeBinding = { ...legacy, contract: "codex-bridge-installed-binding-v2",
    activationReady: true, blocker: null, projectsFile: win32.join(deployment, "projects.json"),
    tunnelProfileDir: win32.join(deployment, ".tunnel-client"), secretPath: win32.join(deployment, ".secrets", "control-plane-api-key.dpapi") };
  const parse = (patch: Partial<InstalledBridgeBinding> = {}) => parseInstalledBinding(JSON.stringify({ ...fixture, ...patch }), fixture.codeRoot, fixture.nodePath);
  assert.deepEqual(parse(), fixture);
  assert.equal(parse().dataDir, legacy.dataDir);
  assert.equal(parse().codexHome, legacy.codexHome);
  assert.equal(parse().handoffDir, legacy.handoffDir);
  for (const key of ["projectsFile", "tunnelProfileDir", "secretPath"] as const) {
    assert.throws(() => parse({ [key]: legacy[key] }), /INSTALLED_BINDING_MISMATCH/);
  }
  assert.throws(() => parse({ codexHome: "C:\\arbitrary-home" }), /INSTALLED_BINDING_MISMATCH/);
  const launch = resolveInstalledCodexLaunch(fixture, ["C:\\fixture-workspace"]);
  for (const name of ["read-only", "workspace"]) {
    const profile = launch.args.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    // All snapshot descendants inherit the owner/runtime deny; the legacy
    // credential directory retains its separate existing deny as well.
    for (const path of [fixture.ownerRoot, fixture.runtimeRoot, fixture.dataDir, fixture.projectsFile]) {
      assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`), path);
    }
  }
});

test("installed child environment has a closed loader/PATH set and does not inherit secrets", () => {
  const binding = bindingFixture();
  const env = installedCodexEnvironment(binding);
  assert.equal(env.CODEX_HOME, binding.codexHome);
  assert.equal(env.USERPROFILE, binding.userProfile);
  assert.deepEqual(Object.keys(env).sort(), ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CODEX_HOME", "TEMP", "TMP", "PATH"].sort());
  assert.equal(env.PATH!.split(";")[0], win32.dirname(binding.nodePath));
  for (const name of ["NODE_OPTIONS", "node_path", "NODE_REPL_EXTERNAL_MODULE", "OPENSSL_CONF", "CODEX_BRIDGE_CODEX_COMMAND",
    "CODEX_BRIDGE_CODEX_ARGS", "CODEX_BRIDGE_NODE_PATH", "CODEX_BRIDGE_TUNNEL_CLIENT_PATH", "CODEX_BRIDGE_KEY_STORE_PATH", "CODEX_BRIDGE_EXPECTED_TEST_BUILD"]) {
    assert.throws(() => assertInstalledEnvironment({ [name]: "injected" }), /INSTALLED_ENV_OVERRIDE_REJECTED/);
  }
  assert.doesNotThrow(() => assertInstalledEnvironment({ PATH: "C:\\untrusted", NODE_OPTIONS: "" }));
});

test("v3 binding pins the migrated single owner and leaves ApprovalStore canonical", () => {
  const legacy = bindingFixture();
  const ownerRoot = "C:\\McpControlCenter";
  const runtimeRoot = win32.join(ownerRoot, "installed-bridge", legacy.releaseId);
  const deployment = win32.join(runtimeRoot, "deployment");
  const fixture: InstalledBridgeBinding = { ...legacy, contract: "codex-bridge-installed-binding-v3", ownerRoot, runtimeRoot,
    dataDir: "C:\\CodexBridge", activationReady: true, blocker: null,
    projectsFile: win32.join(deployment, "projects.json"), tunnelProfileDir: win32.join(deployment, ".tunnel-client"),
    secretPath: win32.join(deployment, ".secrets", "control-plane-api-key.dpapi") };
  const parse = (patch: Partial<InstalledBridgeBinding> = {}) => parseInstalledBinding(JSON.stringify({ ...fixture, ...patch }), fixture.codeRoot, fixture.nodePath);
  assert.deepEqual(parse(), fixture);
  for (const patch of [{ ownerRoot: legacy.ownerRoot }, { runtimeRoot: legacy.runtimeRoot }, { ownerRoot: "C:\\caller-owner" },
    { dataDir: "C:\\second-store" }, { contract: "codex-bridge-installed-binding-v2" as const }, { projectsFile: legacy.projectsFile }]) {
    assert.throws(() => parse(patch), /INSTALLED_BINDING_MISMATCH/);
  }
  const launch = resolveInstalledCodexLaunch(fixture, ["C:\\fixture-workspace"]);
  for (const name of ["read-only", "workspace"]) {
    const profile = launch.args.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    for (const path of [ownerRoot, runtimeRoot, fixture.dataDir]) assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`));
  }
});

test("physical installed marker cannot be selected from a dev runtime or downgraded when manifest is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "installed-marker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = join(root, "codex_bridge"); const config = join(root, "mcp_control_center", "config");
  await mkdir(code); await mkdir(config, { recursive: true });
  assert.equal(await hasInstalledLayout(code), false);
  await writeFile(join(config, "registry.json"), '\uFEFF{"schemaVersion":3}');
  assert.equal(await hasInstalledLayout(code), false);
  await writeFile(join(config, "registry.json"), '{"schemaVersion":4}');
  assert.equal(await hasInstalledLayout(code), true);
  await assert.rejects(loadInstalledBinding({ CODEX_BRIDGE_PROJECT_ROOT: code }), /INSTALLED_LOADED_ROOT_MISMATCH/);
  await writeFile(join(config, "registry.json"), '{"schemaVersion":3}');
  await writeFile(join(config, "installed-release.json"), "malformed");
  assert.equal(await hasInstalledLayout(code), true);
  await assert.rejects(loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: code }), /INSTALLED_LOADED_ROOT_MISMATCH/);
});

test("v4 binding fixes both stores to their component owner and rejects old or cross-owner roots", () => {
  const legacy = bindingFixture();
  const ownerRoot = win32.join(win32.dirname(legacy.configRoot), "mcp_control_center", ".local", "runtime");
  const runtimeRoot = win32.join(ownerRoot, "installed-bridge", legacy.releaseId);
  const deployment = win32.join(runtimeRoot, "deployment");
  const fixture: InstalledBridgeBinding = { ...legacy, contract: "codex-bridge-installed-binding-v4", ownerRoot, runtimeRoot,
    dataDir: win32.join(legacy.configRoot, ".local", "runtime"), activationReady: true, blocker: null,
    projectsFile: win32.join(deployment, "projects.json"), tunnelProfileDir: win32.join(deployment, ".tunnel-client"),
    secretPath: win32.join(deployment, ".secrets", "control-plane-api-key.dpapi") };
  const parse = (patch: Partial<InstalledBridgeBinding> = {}) => parseInstalledBinding(JSON.stringify({ ...fixture, ...patch }), fixture.codeRoot, fixture.nodePath);
  assert.deepEqual(parse(), fixture);
  for (const patch of [{ ownerRoot: "C:\\McpControlCenter" }, { dataDir: "C:\\CodexBridge" },
    { dataDir: ownerRoot }, { ownerRoot: fixture.dataDir }, { runtimeRoot: legacy.runtimeRoot },
    { contract: "codex-bridge-installed-binding-v3" as const }]) {
    assert.throws(() => parse(patch), /INSTALLED_BINDING_MISMATCH/);
  }
  const launch = resolveInstalledCodexLaunch(fixture, ["C:\\fixture-workspace"]);
  for (const name of ["read-only", "workspace"]) {
    const profile = launch.args.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    for (const path of [ownerRoot, runtimeRoot, fixture.dataDir]) assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`));
  }
});

test("source-bound installed configuration cannot initialize JobStore or launch an App Server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "installed-no-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsFile = join(root, "projects.json"); const dataDir = join(root, "absent-data");
  await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: root }] }));
  const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: root, CODEX_BRIDGE_PROJECTS_FILE: projectsFile,
    CODEX_BRIDGE_DATA_DIR: dataDir, CODEX_BRIDGE_CODEX_COMMAND: "fixture-never-launch" });
  config.installedBinding = bindingFixture();
  await assert.rejects(createBridgeRuntime(config), /INSTALLED_LIFECYCLE_BINDINGS_REQUIRED/);
  config.installedBinding = { ...bindingFixture(), activationReady: true, blocker: null };
  // Even the shape of a successful helper response is not a grant: the physically
  // loaded controller, Node path, ACL/operator and selected owner are re-read.
  await assert.rejects(createBridgeRuntime(config), /INSTALLED_LIFECYCLE_BINDINGS_REQUIRED/);
  await assert.rejects(stat(dataDir), { code: "ENOENT" });
  assert.equal((JSON.parse(await readFile(projectsFile, "utf8")) as { projects: unknown[] }).projects.length, 1);
});
