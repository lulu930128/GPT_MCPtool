import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { once } from "node:events";
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(resolve(".tmp") + "\\"));
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const child = spawn(process.execPath, [join(root, "dist/tests/lifecycle-core-fixture.js"), root], {
  windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
    TEMP: process.env.TEMP, TMP: process.env.TMP, LOCALAPPDATA: join(root, "local-appdata"), USERPROFILE: root },
});
let stderr = ""; child.stderr.on("data", b => { stderr += b; });
const exited = once(child, "exit");
const lines = createInterface({ input: child.stdout });
async function bounded(promise, ms) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_TIMEOUT")), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  const [line] = await bounded(Promise.race([once(lines, "line"), exited.then(([code]) => {
    throw new Error(`ISOLATED_START_FAILED (${code}): ${stderr}`);
  })]), 12000), info = JSON.parse(line);
  assert.ok(info.proof, "native Windows identity must be observed, not a fixture proof");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const tunnelPort = probe.address().port; await new Promise(r => probe.close(r));
  const runtimeDir = join(root, ".tmp"); await mkdir(runtimeDir, { recursive: true });
  // Convert native ticks exactly to the existing round-trip ISO owner format.
  const ticks = BigInt(info.proof.startedUtcTicks), unixTicks = ticks - 621355968000000000n;
  const iso = new Date(Number(unixTicks / 10000n)).toISOString().replace(/\.\d{3}Z$/, "." + String(unixTicks % 10000000n).padStart(7, "0") + "Z");
  await writeFile(join(runtimeDir, "codex-bridge-http-server.pid"), String(child.pid));
  await writeFile(join(runtimeDir, "codex-bridge-http-server.owner.json"), JSON.stringify({ schemaVersion: 1,
    role: "server", pid: child.pid, executablePath: process.execPath, startTimeUtc: iso,
    identity: join(root, "dist/src/http-main.js"), recordedAt: new Date().toISOString() }));
  await access(join(root, "state/powershell-approval/approval.lock"));
  // Channel readiness is asynchronous, bounded, and does not perform lifecycle work.
  await new Promise(r => setTimeout(r, 1800));
  const controller = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts/runtime-control.ps1"),
    "-Action", "ShutdownRuntime", "-ProjectRoot", root, "-Port", String(info.port), "-NodePath", process.execPath,
    "-ProjectsFile", join(root, "projects.json"), "-DataDir", join(root, "state"), "-ExpectedBuildId", info.buildId,
    "-TunnelClientPath", process.execPath, "-TunnelProfileDir", join(root, "profiles"), "-TunnelId", "tunnel_isolated",
    "-TunnelHealthUrl", `http://127.0.0.1:${tunnelPort}`, "-KeyStorePath", join(root, "unused.ps1"), "-SecretPath", join(root, "unused")],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
    TEMP: process.env.TEMP, TMP: process.env.TMP, PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" } });
  let output = "", errors = ""; controller.stdout.on("data", b => { output += b; }); controller.stderr.on("data", b => { errors += b; });
  const [code] = await bounded(once(controller, "exit"), 45000);
  assert.equal(code, 0, JSON.stringify({ output, errors, receiverErrors: stderr }));
  const result = JSON.parse(output.replace(/^\uFEFF/, "")); assert.equal(result.ok, true);
  await bounded(exited, 8000);
  await assert.rejects(access(join(root, "state/powershell-approval/approval.lock")), e => e.code === "ENOENT");
  const { ApprovalStore } = await import(new URL("../src/powershell-approval/store.js", new URL(`file:///${join(root, "dist/tests/unused.js").replaceAll("\\", "/")}`)));
  const reopened = await ApprovalStore.open(join(root, "state/powershell-approval")); await reopened.close();
  console.log("PASS: real Windows owner-bound controller -> receiver -> HTTP/runtime/Store close -> original PID exit -> same Store reopen; no kill");
} finally {
  child.stdin.end();
  await bounded(exited, 10000).catch(() => { console.error("ISOLATED_CHILD_EXIT_UNVERIFIED; no forced termination"); process.exitCode = 1; });
  lines.close();
}
