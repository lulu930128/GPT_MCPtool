export class WorkspaceWriteError extends Error {
  constructor(public readonly code: string, message: string = code) {
    super(message);
    this.name = "WorkspaceWriteError";
  }
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
