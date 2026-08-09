const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|token|password|secret|cookie)/i;
export function sanitizeForStorage(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactString(value).slice(0, 8_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForStorage(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeForStorage(item, depth + 1);
    }
    return output;
  }
  return value;
}

export function redactString(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]{12,}\b/gi, "$1[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=\s*)[^\s]+/g, "$1[redacted]");
}
