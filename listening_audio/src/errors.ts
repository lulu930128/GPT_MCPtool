export class ListeningError extends Error {
  constructor(public code: string, public retryable = false, public status?: number) {
    super(code);
  }
}
export function errorResult(error: unknown) {
  const e = error instanceof ListeningError ? error : new ListeningError("INTERNAL_ERROR");
  return { ok: false as const, error: { code: e.code, message: e.code.replaceAll("_", " "),
    retryable: e.retryable, ...(e.status ? { status: e.status } : {}) } };
}
