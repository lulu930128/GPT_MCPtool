import { startEnglishStudyHttpServer } from "../dist/src/http-server.js";

const handle = await startEnglishStudyHttpServer({
  hubBaseUrl: "http://127.0.0.1:18887",
  hubTimeoutMs: 2000,
  host: "127.0.0.1",
  port: 0,
});
try {
  const response = await fetch(new URL("/health", handle.url));
  const health = await response.json();
  if (!response.ok || health.service !== "english-study-mcp" || health.toolCount !== 15 || health.contractVersion !== "english-learning-v1") {
    throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
  }
  console.log(JSON.stringify({ ok: true, health }));
} finally {
  await handle.close();
}
