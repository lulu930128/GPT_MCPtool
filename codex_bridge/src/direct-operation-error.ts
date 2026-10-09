export class DirectOperationError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
