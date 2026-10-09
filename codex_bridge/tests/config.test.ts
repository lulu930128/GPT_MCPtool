import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
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

test("shared roots are opt-in and both execution profiles protect local Bridge state", async (t) => {
  const f = await fixture(t);
  const config = await loadBridgeConfig(f.env);
  for (const name of ["read-only", "workspace"]) {
    const profile = config.codexArgs.find((arg) => arg.startsWith(`permissions.codex-bridge-${name}=`))!;
    assert.ok(profile);
    assert.ok(profile.includes('workspace_roots = {  }'));
    for (const path of [join(f.component, ".local"), join(f.component, ".env"),
      join(f.component, ".env.*"), join(f.component, ".secrets"), join(f.component, ".tunnel-client"),
      f.projectsFile, f.dataDir, join(dirname(f.component), "project_reading", ".secrets")]) {
      assert.ok(profile.includes(`${JSON.stringify(path)} = "deny"`), path);
    }
    assert.ok(profile.includes(`${JSON.stringify(join(f.component, ".tmp", "codex-inbox"))} = "read"`));
    assert.ok(profile.includes('network = { enabled = false }'));
    assert.ok(profile.includes(`extends = ":${name === "workspace" ? "workspace" : "read-only"}"`));
    assert.ok(!profile.includes("package.json"));
  }
  if (process.platform === "win32") assert.ok(config.codexArgs.includes('windows.sandbox="elevated"'));
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
