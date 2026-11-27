import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, parse } from "node:path";
import test from "node:test";
import { loadBridgeConfig } from "../src/config.js";
import { JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";

async function fixture(t: test.TestContext, sharedWorkspaceProjectIds?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "bridge-permissions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const component = join(root, "tools", "bridge");
  const project = join(root, "projects");
  const projectsFile = join(component, ".local", "projects.json");
  const dataDir = join(root, "state");
  await mkdir(dirname(projectsFile), { recursive: true });
  await mkdir(project);
  const policy = { projects: [
    { id: "tools", name: "Tools", path: dirname(component) },
    { id: "projects", name: "Projects", path: project },
  ], ...(sharedWorkspaceProjectIds === undefined ? {} : { sharedWorkspaceProjectIds }) };
  await writeFile(projectsFile, JSON.stringify(policy));
  const env = {
    CODEX_BRIDGE_PROJECT_ROOT: component,
    CODEX_BRIDGE_PROJECTS_FILE: projectsFile,
    CODEX_BRIDGE_DATA_DIR: dataDir,
    CODEX_BRIDGE_CODEX_COMMAND: "codex",
  };
  return { component, project, projectsFile, dataDir, policy, env };
}

test("Full Access is the default; plan and the rollback profile retain sandbox rules", async (t) => {
  const f = await fixture(t);
  const config = await loadBridgeConfig(f.env);
  assert.ok(config.codexArgs.includes('default_permissions=":danger-full-access"'));
  assert.ok(!config.codexArgs.some((arg) => arg.includes('extends = ":danger-full-access"')));
  for (const name of ["read-only", "workspace"]) {
    const profile = config.codexArgs.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    assert.ok(profile);
    assert.ok(profile.includes('workspace_roots = {  }'));
    for (const path of [join(f.component, ".local"), join(f.component, ".env"),
      join(f.component, ".secrets"), join(f.component, ".tunnel-client"),
      f.projectsFile, f.dataDir, join(dirname(f.component), "project_reading", ".secrets")]) {
      assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`), path);
    }
    assert.ok(profile.includes(`${JSON.stringify(join(f.component, ".tmp", "codex-inbox"))} = "read"`));
    assert.ok(profile.includes('network = { enabled = true }'));
    assert.ok(profile.includes(`extends = ":${name === "workspace" ? "workspace" : "read-only"}"`));
    assert.ok(!profile.includes("package.json"));
  }
  if (process.platform === "win32") assert.ok(config.codexArgs.includes('windows.sandbox="elevated"'));
});

test("private npm launcher isolates the Desktop registered-core hint without changing parent or sandbox policy", async (t) => {
  const f = await fixture(t);
  const launcher = join(f.component, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, "// Synthetic launcher; never executed.\n");
  const env = { ...f.env, CODEX_BRIDGE_CODEX_COMMAND: undefined, CODEX_WINDOWS_REGISTERED_CORE: "1",
    codex_windows_registered_core: "1", CODEX_HOME: join(f.component, "codex-home"), PATH: "synthetic-path" };
  const before = { ...env };
  const config = await loadBridgeConfig(env);
  assert.equal(config.codexCommand, process.execPath);
  assert.equal(config.codexArgs[0], launcher);
  assert.notEqual(config.codexEnvironment, env);
  assert.equal(config.codexEnvironment?.CODEX_HOME, env.CODEX_HOME);
  assert.equal(config.codexEnvironment?.PATH, env.PATH);
  assert.deepEqual(env, before);
  if (process.platform === "win32") {
    assert.ok(!Object.keys(config.codexEnvironment!).some((key) => key.toUpperCase() === "CODEX_WINDOWS_REGISTERED_CORE"));
    assert.ok(config.codexArgs.includes('windows.sandbox="elevated"'));
  } else {
    assert.equal(config.codexEnvironment?.CODEX_WINDOWS_REGISTERED_CORE, "1");
  }
});

test("daily private native command drops only the registered-core hint; custom executables remain unchanged", {
  skip: process.platform !== "win32" || !["x64", "arm64"].includes(process.arch),
}, async (t) => {
  const f = await fixture(t);
  const triple = process.arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
  const native = join(f.component, "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", triple, "bin", "codex.exe");
  await mkdir(dirname(native), { recursive: true });
  await writeFile(native, "SYNTHETIC_NOT_EXECUTABLE");
  const codeRoot = join(f.component, "Runtime", "versions", "fixture-sandbox", "codex_bridge");
  await mkdir(codeRoot, { recursive: true });
  const env = { ...f.env, CODEX_BRIDGE_CODEX_COMMAND: native.toUpperCase(), CODEX_BRIDGE_PROJECT_ROOT: codeRoot,
    CODEX_BRIDGE_CONFIG_ROOT: f.component, CODEX_WINDOWS_REGISTERED_CORE: "1", CODEX_HOME: "fixture-home" };
  const config = await loadBridgeConfig(env);
  assert.equal(config.codexEnvironment?.CODEX_WINDOWS_REGISTERED_CORE, undefined);
  assert.equal(config.codexEnvironment?.CODEX_HOME, "fixture-home");
  assert.equal(env.CODEX_WINDOWS_REGISTERED_CORE, "1");
  assert.ok(config.codexArgs.includes('windows.sandbox="elevated"'));
  for (const command of ["codex", join(f.component, "custom", "codex.exe")]) {
    const custom = await loadBridgeConfig({ ...env, CODEX_BRIDGE_CODEX_COMMAND: command });
    assert.equal(custom.codexEnvironment, undefined);
    assert.equal(custom.codexCommand, command);
  }
});

test("environment deny globs exclude only the example and preserve synthetic secret variants", async (t) => {
  const f = await fixture(t);
  const config = await loadBridgeConfig(f.env);
  const profile = config.codexArgs.find((arg) => arg.startsWith("permissions.codex-bridge-read-only="))!;
  const denies = [...profile.matchAll(/("(?:[^"\\]|\\.)*") = "deny"/g)].map((match) => JSON.parse(match[1]!) as string);
  const denied = (name: string) => denies.some((glob) => matchesGlob(join(f.component, name), glob));
  for (const name of [".env", ".env.local", ".env.production", ".env.e", ".env.ex", ".env.exampl",
    ".env.example.bak", ".env.examples", ".env.EXAMPLES", ".env.exAmple.private", ".env.x"]) {
    await writeFile(join(f.component, name), "SYNTHETIC_FIXTURE_ONLY=not-a-credential");
    assert.equal(denied(name), true, name);
  }
  for (const name of [".env.example", ".env.EXAMPLE", "AGENTS.md", "package.json"]) {
    assert.equal(denied(name), false, name);
  }
});

test("daily installed code uses the stable config root and configured credential directory", async (t) => {
  const f = await fixture(t);
  const release = join(f.component, "Runtime", "versions", "fixture-v2");
  const codeRoot = join(release, "codex_bridge");
  const credentialDir = join(dirname(f.component), "custom-credentials");
  await mkdir(codeRoot, { recursive: true });
  const config = await loadBridgeConfig({ ...f.env, CODEX_BRIDGE_PROJECT_ROOT: codeRoot,
    CODEX_BRIDGE_CONFIG_ROOT: f.component, CODEX_BRIDGE_SECRET_PATH: join(credentialDir, "fixture.dpapi") });
  assert.equal(config.projectRoot, codeRoot);
  assert.equal(config.widgetPath, join(codeRoot, "web", "codex-console.html"));
  assert.equal(config.handoffDir, join(f.component, ".tmp", "codex-inbox"));
  for (const name of ["read-only", "workspace"]) {
    const profile = config.codexArgs.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    for (const path of [credentialDir, join(f.component, ".local"), join(dirname(f.component), "project_reading", ".secrets")]) {
      assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`), path);
    }
    assert.ok(profile.includes(`${JSON.stringify(codeRoot)} = "read"`));
    assert.ok(!profile.includes(JSON.stringify(join(release, "project_reading", ".secrets"))));
    assert.ok(!profile.includes(JSON.stringify(join(codeRoot, ".local"))));
  }
  // Real JobStore initialization must also leave the immutable release empty.
  await new JobStore(config.jobsDir, config.handoffDir).initialize();
  assert.deepEqual(await readdir(release), ["codex_bridge"]);
  assert.deepEqual(await readdir(codeRoot), []);
});

test("configured policy paths reject relative input and credential parents of readable roots", async (t) => {
  const f = await fixture(t);
  for (const name of ["CODEX_BRIDGE_CONFIG_ROOT", "CODEX_BRIDGE_SECRET_PATH"]) {
    await assert.rejects(loadBridgeConfig({ ...f.env, [name]: "relative/path" }), /BRIDGE_CONFIG_PATH_INVALID/);
  }
  await assert.rejects(loadBridgeConfig({ ...f.env, CODEX_BRIDGE_SECRET_PATH: join(f.project, "fixture.dpapi") }),
    /PERMISSION_PROFILE_DENIED_PARENT/);
});

test("handoff cannot be reopened beneath a denied data parent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadBridgeConfig({ ...f.env, CODEX_BRIDGE_DATA_DIR: join(f.component, ".tmp") }),
    /PERMISSION_PROFILE_DENIED_PARENT/);
  await assert.rejects(loadBridgeConfig({ ...f.env, CODEX_BRIDGE_DATA_DIR: f.component }),
    /PERMISSION_PROFILE_DENIED_PARENT/);
  await assert.rejects(loadBridgeConfig({ ...f.env, CODEX_BRIDGE_DATA_DIR: f.project }),
    /PERMISSION_PROFILE_DENIED_PARENT/);
  // A sibling whose name shares a prefix is not a parent.
  await assert.doesNotReject(loadBridgeConfig({ ...f.env, CODEX_BRIDGE_DATA_DIR: `${f.component}-state` }));
});

test("Windows default data belongs to the component local runtime", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const expected = join(f.component, ".local", "runtime");
  await mkdir(expected, { recursive: true });
  const config = await loadBridgeConfig({ ...f.env, CODEX_BRIDGE_DATA_DIR: undefined });
  assert.equal(config.dataDir, expected);
  assert.equal(config.jobsDir, join(expected, "jobs"));
});

test("shared roots resolve only configured project ids and do not duplicate roots", async (t) => {
  const f = await fixture(t, ["projects", "tools", "projects"]);
  const config = await loadBridgeConfig(f.env);
  const expected = [config.projects.get("projects")!.path, config.projects.get("tools")!.path]
    .map((path) => `${JSON.stringify(path)} = true`).join(", ");
  for (const name of ["read-only", "workspace"]) {
    const profile = config.codexArgs.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    assert.ok(profile.includes(`workspace_roots = { ${expected} }`));
  }
});

test("invalid shared-root settings fail closed", async (t) => {
  for (const value of [null, "projects", ["unknown"], [42], ["../escape"]]) {
    const f = await fixture(t, value);
    await assert.rejects(loadBridgeConfig(f.env), /sharedWorkspaceProjectIds/);
  }
});

test("filesystem roots cannot become shared workspaces", async (t) => {
  const f = await fixture(t, ["projects"]);
  f.policy.projects[1]!.path = parse(f.project).root;
  await writeFile(f.projectsFile, JSON.stringify(f.policy));
  await assert.rejects(loadBridgeConfig(f.env), /filesystem root/);
});

test("existing attachments rematerialize outside protected local settings without deleting old copies", async (t) => {
  const f = await fixture(t);
  const config = await loadBridgeConfig(f.env);
  const oldHandoff = join(f.component, ".local", "codex-inbox");
  const before = new JobStore(config.jobsDir, oldHandoff);
  await before.initialize();
  const id = randomUUID();
  const content = "Verified attachment contents";
  const preview = previewWorkPackage({ projectId: "projects", title: "Attachment", objective: "Read", inputBundleIds: [id] });
  const created = await before.create({
    project: config.projects.get("projects")!, workPackage: preview.workPackage,
    previewDigest: preview.previewDigest, idempotencyKey: "attachment-path-migration",
    inputArtifacts: [{ id, fileName: "notes.txt", mimeType: "text/plain", chars: content.length,
      bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), content }],
  });
  const after = new JobStore(config.jobsDir, config.handoffDir);
  await after.initialize();
  const [artifact] = await after.readInputArtifacts(created.record.id, [id]);
  assert.equal(artifact?.localPath, join(config.handoffDir, created.record.id, `${id}.txt`));
  assert.equal(await readFile(artifact!.localPath, "utf8"), content);
  assert.equal(await readFile(join(oldHandoff, created.record.id, `${id}.txt`), "utf8"), content);
  await writeFile(join(config.jobsDir, created.record.id, "inbox", `${id}.txt`), "tampered");
  await assert.rejects(after.readInputArtifacts(created.record.id, [id]), /failed SHA-256 validation/);
});
