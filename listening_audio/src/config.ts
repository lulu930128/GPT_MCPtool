export interface Config {
  host: string; port: number; trainerBaseUrl: string; token?: string;
  timeoutMs: number; maxQuestions: number; maxTextLength: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${key}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}.`);
    return value;
  };
  const host = env.LISTENING_MCP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("LISTENING_MCP_HOST must be 127.0.0.1.");
  const url = new URL(env.LISTENING_TRAINER_BASE_URL ?? "http://127.0.0.1:8765");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("Trainer must be a loopback HTTP origin using 127.0.0.1.");
  const token = env.LISTENING_MCP_HTTP_TOKEN;
  if (token !== undefined && (token.length < 32 || token.length > 512 || /[\s<>]/.test(token))) {
    throw new Error("LISTENING_MCP_HTTP_TOKEN must be 32-512 non-whitespace characters, not a placeholder.");
  }
  return { host, port: number("LISTENING_MCP_PORT", 18810, 1, 65535), trainerBaseUrl: url.origin, token,
    timeoutMs: number("LISTENING_REQUEST_TIMEOUT_MS", 300000, 1000, 300000),
    maxQuestions: number("LISTENING_MAX_QUESTIONS", 20, 1, 20),
    maxTextLength: number("LISTENING_MAX_TEXT_LENGTH", 5000, 1, 5000) };
}
