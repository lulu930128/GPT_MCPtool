import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(".");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out-dir" || !path.isAbsolute(args[1]))) {
  throw new Error("Expected --out-dir followed by an absolute staging directory.");
}
const outputRoot = args.length ? path.resolve(args[1]) : path.join(projectRoot, "dist");
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

await fs.mkdir(outputRoot, { recursive: true });
await fs.writeFile(
  path.join(outputRoot, "build-info.json"),
  `${JSON.stringify({ buildId, buildTime, gitCommit, dirty }, null, 2)}\n`,
  "utf8",
);
