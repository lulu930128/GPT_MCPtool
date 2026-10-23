import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
const root = resolve(process.argv[2]);
const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port;
try {
  for (const includePathExt of [false, true]) {
  console.log(JSON.stringify({ includePathExt, port }));
  const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    resolve("tests/diagnose-fixture-listener.ps1"), "-Port", String(port), "-ModulePath", join(root, "scripts/codex-bridge-runtime.psm1")],
  { windowsHide: true, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
    TEMP: process.env.TEMP, TMP: process.env.TMP, PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    ...(includePathExt ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}) } });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const [code] = await once(child, "exit"); process.exitCode = code ?? 1;
  }
} finally { await new Promise(r => server.close(r)); }
