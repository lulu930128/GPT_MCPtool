import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTerminationReason = "timeout" | "output_limit" | "caller_stop";

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStdoutLine?: (
    line: string,
    child: ChildProcess,
  ) => "continue" | "stop" | void;
}

export interface BoundedProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  terminationReason?: ProcessTerminationReason;
}

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? 2_097_152;
  const maxStderrBytes = options.maxStderrBytes ?? 262_144;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutBuffer = "";
    let terminationReason: ProcessTerminationReason | undefined;
    let settled = false;

    const terminate = (reason: ProcessTerminationReason): void => {
      terminationReason ??= reason;
      if (!child.killed) {
        child.kill();
      }
    };
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminationReason === "output_limit") {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        terminate("output_limit");
        return;
      }
      const text = chunk.toString("utf8");
      stdout += text;
      if (!options.onStdoutLine) {
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (options.onStdoutLine(line, child) === "stop") {
          terminate("caller_stop");
          break;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminationReason === "output_limit") {
        return;
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) {
        terminate("output_limit");
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      if (stdoutBuffer && options.onStdoutLine && !terminationReason) {
        options.onStdoutLine(stdoutBuffer, child);
      }
      settled = true;
      resolve({ code, stdout, stderr, terminationReason });
    });
  });
}
