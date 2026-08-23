import { isIP } from "node:net";

export interface EnglishStudyMcpConfig {
  hubBaseUrl: string;
  hubApiToken?: string;
  hubTimeoutMs: number;
  host: string;
  port: number;
  httpToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnglishStudyMcpConfig {
  const hubBaseUrl = normalizeHubUrl(env.ESTUDY_HUB_BASE_URL || "http://127.0.0.1:18887");
  const hubApiToken = env.ESTUDY_HUB_API_TOKEN?.trim() || undefined;
  const hubTimeoutMs = parsePositiveInt(env.ESTUDY_HUB_TIMEOUT_MS, 10_000);
  const host = env.ESTUDY_MCP_HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.ESTUDY_MCP_PORT, 18886);
  const httpToken = env.ESTUDY_MCP_HTTP_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(host) && !httpToken) {
    throw new Error("ESTUDY_MCP_HTTP_TOKEN is required for a non-loopback MCP bind.");
  }
  if (hubBaseUrl.startsWith("http://") && !isLoopbackUrl(hubBaseUrl)) {
    throw new Error("Remote ESTUDY_HUB_BASE_URL must use HTTPS.");
  }
  return { hubBaseUrl, hubApiToken, hubTimeoutMs, host, port, httpToken };
}

export function isLoopbackHost(value: string): boolean {
  if (value.toLowerCase() === "localhost") return true;
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith("127.");
  return version === 6 && normalized === "::1";
}

function isLoopbackUrl(value: string): boolean {
  return isLoopbackHost(new URL(value).hostname);
}

function normalizeHubUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ESTUDY_HUB_BASE_URL must use http or https.");
  }
  if (url.username || url.password) throw new Error("Do not embed credentials in ESTUDY_HUB_BASE_URL.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${value}.`);
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`Invalid port: ${value}.`);
  return parsed;
}
