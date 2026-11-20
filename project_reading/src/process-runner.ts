import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTerminationReason = "timeout" | "output_limit" | "caller_stop";

export interface BoundedProcessOptions {
  streamLines?: boolean;
  byteRange?: { offset: number; length: number };
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
  raw?: Buffer;
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
    const decoder = new TextDecoder();
    const raw: Buffer[] = [];
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
      if (terminationReason) return;
      const range = options.byteRange;
      if (range) {
        const start = Math.max(0, range.offset - stdoutBytes);
        const end = Math.min(chunk.length, range.offset + range.length - stdoutBytes);
        if (end > start) raw.push(chunk.subarray(start, end));
        stdoutBytes += chunk.length;
        if (stdoutBytes > range.offset + range.length) terminate("caller_stop");
        return;
      }
      stdoutBytes += chunk.byteLength;
      if ((options.streamLines ? Buffer.byteLength(stdoutBuffer) + chunk.byteLength : stdoutBytes) > maxStdoutBytes) {
        terminate("output_limit");
        return;
      }
      const text = decoder.decode(chunk, { stream: true });
      if (!options.streamLines) stdout += text;
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
      resolve({ code, stdout, stderr, terminationReason, ...(options.byteRange ? { raw: Buffer.concat(raw) } : {}) });
    });
  });
}
