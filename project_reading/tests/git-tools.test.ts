import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { gitDiff, gitDiffFile, gitStatusSummary } from "../src/git-tools.js";
import { listProjects } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

test("Git status and metadata stay scoped to a monorepo child", async () => {
  const fixture = await makeGitFixture();
  await fs.writeFile(path.join(fixture.other, "outside.txt"), "outside changed\n", "utf8");

  const clean = (await gitStatusSummary(fixture.config, { project: "project" })) as {
    changedFiles: string[];
    git: { relation: string; scope: string; hasOwnGitRoot: boolean; hasTrackedFiles: boolean };
  };
  assert.deepEqual(clean.changedFiles, []);
  assert.equal(clean.git.relation, "parent");
  assert.equal(clean.git.scope, "project");
  assert.equal(clean.git.hasOwnGitRoot, false);
  assert.equal(clean.git.hasTrackedFiles, true);

  const projects = (await listProjects(fixture.config)) as {
    projects: Array<{
      name: string;
      isGitTracked: boolean;
      hasOwnGitRoot: boolean;
      git: { relation: string };
    }>;
  };
  const project = projects.projects.find((item) => item.name === "project");
  assert.equal(project?.isGitTracked, true);
  assert.equal(project?.hasOwnGitRoot, false);
  assert.equal(project?.git.relation, "parent");
});

test("Git diff separates staged and unstaged patches and omits denied tracked paths", async () => {
  const fixture = await makeGitFixture();
  await fs.writeFile(path.join(fixture.project, "staged.ts"), "export const staged = 2;\n", "utf8");
  await git(fixture.root, "add", "project/staged.ts");
  await fs.writeFile(path.join(fixture.project, "unstaged.ts"), "export const unstaged = 2;\n", "utf8");
  await fs.writeFile(path.join(fixture.project, ".env"), "SECRET=changed\n", "utf8");

  const staged = (await gitDiff(fixture.config, {
    project: "project",
    mode: "staged",
  })) as { files: Array<{ path: string; diff: string }> };
  assert.deepEqual(staged.files.map((file) => file.path), ["staged.ts"]);
  assert.match(staged.files[0]?.diff ?? "", /staged = 2/);

  const unstaged = (await gitDiff(fixture.config, {
    project: "project",
    mode: "unstaged",
  })) as { files: Array<{ path: string; diff: string }>; omitted: { denied: number }; partial: boolean };
  assert.deepEqual(unstaged.files.map((file) => file.path), ["unstaged.ts"]);
  assert.equal(unstaged.omitted.denied, 1);
  assert.equal(unstaged.partial, true);
  assert.doesNotMatch(JSON.stringify(unstaged), /SECRET=changed/);

  const one = (await gitDiffFile(fixture.config, {
    project: "project",
    path: "unstaged.ts",
  })) as { file: { path: string; additions: number; deletions: number } };
  assert.equal(one.file.path, "unstaged.ts");
  assert.equal(one.file.additions, 1);
  assert.equal(one.file.deletions, 1);

  await assert.rejects(
    () => gitDiffFile(fixture.config, { project: "project", path: "C:\\outside.txt" }),
    /relative to the selected project/,
  );
});

test("Git diff handles rename, deletion, and bounded untracked text", async () => {
  const fixture = await makeGitFixture();
  await git(fixture.root, "mv", "project/rename-me.ts", "project/renamed.ts");
  await fs.rm(path.join(fixture.project, "delete-me.ts"));
  await fs.writeFile(path.join(fixture.project, "new.ts"), "export const created = true;\n", "utf8");

  const status = (await gitStatusSummary(fixture.config, { project: "project" })) as {
    changes: Array<{ path: string; oldPath?: string; status: string }>;
  };
  assert.ok(status.changes.some((change) => change.path === "renamed.ts" && change.status === "renamed"));
  assert.ok(status.changes.some((change) => change.path === "delete-me.ts" && change.status === "deleted"));

  const diff = (await gitDiff(fixture.config, {
    project: "project",
    mode: "all",
    includeUntracked: true,
  })) as { files: Array<{ path: string; status: string; diff: string }> };
  assert.ok(diff.files.some((file) => file.path === "renamed.ts" && file.status === "renamed"));
  assert.ok(diff.files.some((file) => file.path === "delete-me.ts" && file.status === "deleted"));
  assert.ok(diff.files.some((file) => file.path === "new.ts" && file.status === "untracked"));
});

async function makeGitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-tools-"));
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  await fs.mkdir(project);
  await fs.mkdir(other);
  await git(root, "init", "-q");
  await fs.writeFile(path.join(project, "staged.ts"), "export const staged = 1;\n", "utf8");
  await fs.writeFile(path.join(project, "unstaged.ts"), "export const unstaged = 1;\n", "utf8");
  await fs.writeFile(path.join(project, "rename-me.ts"), "export const renamed = 1;\n", "utf8");
  await fs.writeFile(path.join(project, "delete-me.ts"), "export const deleted = 1;\n", "utf8");
  await fs.writeFile(path.join(project, ".env"), "SECRET=initial\n", "utf8");
  await fs.writeFile(path.join(other, "outside.txt"), "outside initial\n", "utf8");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Project Reading Tests",
    "-c",
    "user.email=project-reading@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
  });
  return { root, project, other, config };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    windowsHide: true,
  });
}
