import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const identitySchema = z.object({ pid: z.number().int().positive(), startedUtcTicks: z.string().regex(/^\d{18}$/),
  sid: z.string().regex(/^S-1-/), image: z.string().min(1), session: z.number().int().nonnegative() }).strict();
export type ProcessIdentity = z.infer<typeof identitySchema>;
let ownIdentity: Promise<ProcessIdentity | undefined> | undefined;
let observedIdentity: ProcessIdentity | undefined;
/** Store opens never launch a process. Only the HTTP composition root observes OS identity. */
export function observedCurrentProcessIdentity(): ProcessIdentity | undefined {
  return observedIdentity && { ...observedIdentity };
}
/** Fixed read-only native verifier. Failure is diagnostic UNKNOWN, never authority. */
export function currentProcessIdentity(): Promise<ProcessIdentity | undefined> {
  return ownIdentity ??= (async () => {
    if (process.platform !== "win32") return undefined;
    try {
      const result = await promisify(execFile)("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("../../scripts/process-identity.ps1", import.meta.url)),
          "-ProcessId", String(process.pid)], { windowsHide: true, timeout: 5000, maxBuffer: 8192,
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: process.env.TEMP, TMP: process.env.TMP,
            PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" } });
      const proof = identitySchema.parse(JSON.parse(result.stdout.replace(/^\uFEFF/, "")));
      if (proof.pid !== process.pid || proof.image.toLowerCase() !== process.execPath.toLowerCase()) return undefined;
      observedIdentity = proof;
      return proof;
    } catch { return undefined; }
  })();
}
