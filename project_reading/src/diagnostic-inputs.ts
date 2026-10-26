import { isIP } from "node:net";
import { z } from "zod";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  timeoutMs: 10_000, maxResults: 100, maxBodyBytes: 16_384,
  maxStdoutBytes: 262_144, maxStderrBytes: 4_096, maxConcurrent: 8,
});

export function isDiagnosticHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (isIP(value)) return true;
  if (/^[\d.]+$/.test(value)) return false;
  return value.replace(/\.$/, "").split(".").every(
    (label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
  );
}

const host = z.string().max(253).refine(isDiagnosticHost, "Expected an IP literal or ASCII DNS hostname.");
const port = z.number().int().min(1).max(65_535);
const timeoutMs = z.number().int().min(100).max(DIAGNOSTIC_LIMITS.timeoutMs).default(3_000);
const maxResults = z.number().int().min(1).max(DIAGNOSTIC_LIMITS.maxResults).default(50);
const address = z.string().max(45).refine((value) => isIP(value) !== 0, "Expected an IP literal.").optional();

function validHealthUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && url.port !== "0"
      && isDiagnosticHost(url.hostname.replace(/^\[|\]$/g, ""));
  } catch { return false; }
}

export const diagnosticSchemas = {
  check_tcp_port: z.object({ host, port, timeoutMs }).strict(),
  list_listening_ports: z.object({ port: port.optional(), address,
    family: z.enum(["ipv4", "ipv6"]).optional(), maxResults, timeoutMs }).strict(),
  inspect_port_owner: z.object({ port, address, maxResults, timeoutMs }).strict(),
  resolve_dns: z.object({ hostname: host, family: z.enum(["ipv4", "ipv6", "all"]).default("all"),
    maxResults, timeoutMs }).strict(),
  ping_host: z.object({ host, timeoutMs }).strict(),
  http_health_check: z.object({ url: z.string().max(2_048).refine(validHealthUrl,
    "Expected an HTTP(S) URL without credentials, fragment, whitespace or backslash."),
    timeoutMs, maxBodyBytes: z.number().int().min(0).max(DIAGNOSTIC_LIMITS.maxBodyBytes).default(1_024) }).strict(),
};
export type DiagnosticTool = keyof typeof diagnosticSchemas;
