import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runFile = promisify(execFile);
// This source candidate targets the verified existing Windows x64 host layout.
// An alternate Windows installation needs its own operator binding; never use PATH/SystemRoot input.
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export interface InstalledBridgeBinding {
  contract: "codex-bridge-installed-binding-v1" | "codex-bridge-installed-binding-v2" | "codex-bridge-installed-binding-v3" | "codex-bridge-installed-binding-v4";
  releaseId: string;
  releaseRoot: string;
  codeRoot: string;
  configRoot: string;
  runtimeRoot: string;
  ownerRoot: string;
  projectsFile: string;
  dataDir: string;
  codexHome: string;
  handoffDir: string;
  operatorSid: string;
  userProfile: string;
  localAppData: string;
  windowsRoot: string;
  nodePath: string;
  tunnelClientPath: string;
  keyStorePath: string;
  codexLauncher: string;
  codexNative: string;
  tunnelProfileDir: string;
  secretPath: string;
  activationReady: boolean;
  blocker: "INSTALLED_LIFECYCLE_BINDINGS_REQUIRED" | null;
}

export async function hasInstalledLayout(root: string = componentRoot): Promise<boolean> {
  const config = join(dirname(root), "mcp_control_center", "config");
  try {
    await lstat(join(config, "installed-release.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const path = join(config, "registry.json");
    if ((await lstat(path)).size > 65536) throw new Error("INSTALLED_REGISTRY_LIMIT");
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")).schemaVersion === 4;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export function assertInstalledEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^(NODE_|OPENSSL_)/i.test(name) || /^(CODEX_BRIDGE_(CODEX_COMMAND|CODEX_ARGS|NODE_PATH|TUNNEL_CLIENT_PATH|KEY_STORE_PATH|EXPECTED_TEST_BUILD|TEST_ACTIVE_FLAG))$/i.test(name)) {
      throw new Error("INSTALLED_ENV_OVERRIDE_REJECTED");
    }
  }
}

export function parseInstalledBinding(raw: string, codeRoot: string, nodePath: string): InstalledBridgeBinding {
  if (Buffer.byteLength(raw, "utf8") > 16384) throw new Error("INSTALLED_BINDING_LIMIT");
  const binding = JSON.parse(raw.replace(/^\uFEFF/, "")) as InstalledBridgeBinding;
  const fields = ["contract", "releaseId", "releaseRoot", "codeRoot", "configRoot", "runtimeRoot", "ownerRoot", "projectsFile", "dataDir", "codexHome", "handoffDir", "operatorSid", "userProfile", "localAppData", "windowsRoot", "nodePath", "tunnelClientPath", "keyStorePath", "codexLauncher", "codexNative", "tunnelProfileDir", "secretPath", "activationReady", "blocker"];
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).sort().join() !== fields.sort().join() ||
      !["codex-bridge-installed-binding-v1", "codex-bridge-installed-binding-v2", "codex-bridge-installed-binding-v3", "codex-bridge-installed-binding-v4"].includes(binding.contract) ||
      !((binding.activationReady === false && binding.blocker === "INSTALLED_LIFECYCLE_BINDINGS_REQUIRED") || (binding.activationReady === true && binding.blocker === null)) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(binding.releaseId) || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(binding.operatorSid)) {
    throw new Error("INSTALLED_BINDING_INVALID");
  }
  for (const field of fields.filter((name) => !["contract", "releaseId", "operatorSid", "activationReady", "blocker"].includes(name))) {
    const path = binding[field as keyof InstalledBridgeBinding];
    if (typeof path !== "string" || !/^[A-Za-z]:\\[^/:*?"<>|\r\n\0]+$/.test(path) || /(^|\\)\.{1,2}(\\|$)|[ .](\\|$)|\\\\/.test(path) || win32.normalize(path) !== path) {
      throw new Error("INSTALLED_BINDING_PATH_INVALID");
    }
  }
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const migratedOwner = binding.contract === "codex-bridge-installed-binding-v3";
  const componentOwned = binding.contract === "codex-bridge-installed-binding-v4";
  const snapshots = binding.contract !== "codex-bridge-installed-binding-v1";
  const ownerRoot = componentOwned ? win32.join(win32.dirname(binding.configRoot), "mcp_control_center", ".local", "runtime") :
    migratedOwner ? "C:\\McpControlCenter" : win32.join(binding.localAppData, "McpControlCenter");
  const deploymentRoot = win32.join(binding.runtimeRoot, "deployment");
  const expected = {
    codeRoot: win32.join(binding.releaseRoot, "codex_bridge"),
    nodePath: win32.join(binding.releaseRoot, "dependencies", "node", "node.exe"),
    tunnelClientPath: win32.join(binding.releaseRoot, "dependencies", "tunnel-client", "tunnel-client.exe"),
    keyStorePath: win32.join(binding.releaseRoot, "dependencies", "key-store", "key-store.ps1"),
    codexLauncher: win32.join(binding.codeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
    codexNative: win32.join(binding.codeRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    ownerRoot,
    runtimeRoot: win32.join(ownerRoot, "installed-bridge", binding.releaseId),
    handoffDir: win32.join(binding.configRoot, ".tmp", "codex-inbox"),
    tunnelProfileDir: win32.join(snapshots ? deploymentRoot : binding.configRoot, ".tunnel-client"),
    secretPath: snapshots ? win32.join(deploymentRoot, ".secrets", "control-plane-api-key.dpapi") :
      win32.join(win32.dirname(binding.configRoot), "project_reading", ".secrets", "control-plane-api-key.dpapi"),
    ...(snapshots ? { projectsFile: win32.join(deploymentRoot, "projects.json"), codexHome: win32.join(binding.userProfile, ".codex") } : {}),
    ...(migratedOwner ? { dataDir: "C:\\CodexBridge" } : {}),
    ...(componentOwned ? { dataDir: win32.join(binding.configRoot, ".local", "runtime") } : {}),
  };
  if (!equal(binding.codeRoot, codeRoot) || !equal(binding.nodePath, nodePath) || win32.basename(binding.releaseRoot) !== binding.releaseId ||
      !equal(binding.windowsRoot, "C:\\Windows") || Object.entries(expected).some(([key, value]) => !equal(binding[key as keyof typeof expected], value))) {
    throw new Error("INSTALLED_BINDING_MISMATCH");
  }
  for (const path of [binding.configRoot, binding.runtimeRoot, binding.ownerRoot, binding.projectsFile, binding.dataDir, binding.codexHome, binding.handoffDir]) {
    const a = path.toLowerCase(); const b = binding.releaseRoot.toLowerCase();
    if (a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`)) throw new Error("INSTALLED_STATE_CODE_OVERLAP");
  }
  return Object.freeze(binding);
}

export async function loadInstalledBinding(env: NodeJS.ProcessEnv): Promise<InstalledBridgeBinding | undefined> {
  if (!await hasInstalledLayout()) {
    if (env.CODEX_BRIDGE_PROJECT_ROOT && await hasInstalledLayout(resolve(env.CODEX_BRIDGE_PROJECT_ROOT))) throw new Error("INSTALLED_LOADED_ROOT_MISMATCH");
    return undefined;
  }
  assertInstalledEnvironment(env);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("INSTALLED_PLATFORM_UNSUPPORTED");
  if (env.CODEX_BRIDGE_PROJECT_ROOT && resolve(env.CODEX_BRIDGE_PROJECT_ROOT).toLowerCase() !== componentRoot.toLowerCase()) throw new Error("INSTALLED_LOADED_ROOT_MISMATCH");
  // The existing controller is the one Windows ACL/operator verifier. This fixed read-only
  // action performs no lifecycle, policy read, DPAPI operation, probe or runtime write.
  const helperEnv: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" };
  helperEnv.PSModulePath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules";
  for (const name of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "CODEX_BRIDGE_HTTP_TOKEN"]) if (env[name]) helperEnv[name] = env[name];
  const result = await runFile(powershell, ["-NoProfile", "-NonInteractive", "-File", join(componentRoot, "scripts", "runtime-control.ps1"), "-Action", "InstalledBinding"],
    { cwd: componentRoot, env: helperEnv, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 16384, encoding: "utf8" });
  if (result.stderr.trim()) throw new Error("INSTALLED_BINDING_STDERR");
  const binding = parseInstalledBinding(result.stdout, componentRoot, process.execPath);
  if ((env.CODEX_BRIDGE_HTTP_HOST && env.CODEX_BRIDGE_HTTP_HOST !== "127.0.0.1") ||
      (env.CODEX_BRIDGE_HTTP_PORT && env.CODEX_BRIDGE_HTTP_PORT !== "18828")) throw new Error("INSTALLED_ENDPOINT_OVERRIDE_REJECTED");
  for (const [name, expected] of Object.entries({ CODEX_BRIDGE_PROJECTS_FILE: binding.projectsFile, CODEX_BRIDGE_DATA_DIR: binding.dataDir, CODEX_HOME: binding.codexHome })) {
    if (env[name] && env[name]!.toLowerCase() !== expected.toLowerCase()) throw new Error("INSTALLED_STATE_OVERRIDE_REJECTED");
  }
  return binding;
}

export function installedCodexEnvironment(binding: InstalledBridgeBinding): NodeJS.ProcessEnv {
  // Only the existing host's verified tool locations; never inherit ambient PATH
  // or env values. Node/npm remain pinned to the release dependency directory.
  const toolPaths = process.platform === "win32" ? [
    "C:\\work\\Git\\cmd\\git.exe", "C:\\miniconda3\\python.exe",
  ].filter(isRegularToolPath).map((path) => win32.dirname(path)) : [];
  return { SystemRoot: binding.windowsRoot, WINDIR: binding.windowsRoot, USERPROFILE: binding.userProfile,
    LOCALAPPDATA: binding.localAppData, APPDATA: win32.join(binding.userProfile, "AppData", "Roaming"), CODEX_HOME: binding.codexHome,
    TEMP: win32.join(binding.localAppData, "Temp"), TMP: win32.join(binding.localAppData, "Temp"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [win32.dirname(binding.nodePath), win32.join(binding.windowsRoot, "System32"), win32.dirname(powershell), ...toolPaths].join(";") };
}

function isRegularToolPath(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    for (let parent = win32.dirname(path); parent !== win32.dirname(parent); parent = win32.dirname(parent)) {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function assertInstalledRuntimeActivation(expected?: InstalledBridgeBinding): Promise<void> {
  const actual = await loadInstalledBinding(process.env);
  if (!actual && !expected) return;
  if (!actual?.activationReady || !expected?.activationReady) throw new Error("INSTALLED_LIFECYCLE_BINDINGS_REQUIRED");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("INSTALLED_CONTEXT_TAMPERED");
  const require = createRequire(actual.codexLauncher);
  const packagePath = require.resolve("@openai/codex-win32-x64/package.json");
  if (packagePath.toLowerCase() !== win32.join(actual.codeRoot, "node_modules", "@openai", "codex-win32-x64", "package.json").toLowerCase()) {
    throw new Error("INSTALLED_CODEX_RESOLUTION_REJECTED");
  }
  const cli = JSON.parse(await readFile(win32.join(actual.codeRoot, "node_modules", "@openai", "codex", "package.json"), "utf8"));
  const native = JSON.parse(await readFile(packagePath, "utf8"));
  if (cli.version !== "0.154.0" || native.version !== "0.154.0-win32-x64") throw new Error("INSTALLED_CODEX_VERSION_REJECTED");
}
