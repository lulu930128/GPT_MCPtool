import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(".");
const packageMetadata = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const buildTime = new Date().toISOString();
let gitCommit = null;
let dirty = null;

try {
  const commit = await execFileAsync("git", ["--no-optional-locks", "-C", projectRoot, "rev-parse", "HEAD"], {
    windowsHide: true,
    timeout: 5_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  gitCommit = commit.stdout.trim() || null;
  const status = await execFileAsync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", projectRoot, "status", "--porcelain", "--", "."],
    {
      windowsHide: true,
      timeout: 5_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  dirty = status.stdout.length > 0;
} catch {
  // Packaged source may not retain Git metadata; represent that state as unknown.
}

const buildId = createHash("sha256")
  .update(
    JSON.stringify({
      applicationVersion: packageMetadata.version,
      toolContractVersion: packageMetadata.toolContractVersion,
      buildTime,
      gitCommit,
      dirty,
    }),
  )
  .digest("hex")
  .slice(0, 20);

await fs.mkdir(path.join(projectRoot, "dist"), { recursive: true });
await fs.writeFile(
  path.join(projectRoot, "dist", "build-info.json"),
  `${JSON.stringify({ buildId, buildTime, gitCommit, dirty }, null, 2)}\n`,
  "utf8",
);
