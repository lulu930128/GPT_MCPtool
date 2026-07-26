import { loadConfig } from "../dist/src/config.js";
import { startWorkspaceHttpServer } from "../dist/src/http-server.js";

const config = await loadConfig({
  ...process.env,
  WORKSPACE_MCP_ROOT: process.env.WORKSPACE_MCP_ROOT || "C:\\project",
});

const handle = await startWorkspaceHttpServer(config, {
  host: "127.0.0.1",
  port: 0,
  bearerToken: "smoke-token",
});

try {
  const healthUrl = `http://${handle.host}:${handle.port}/health`;
  const healthResponse = await fetch(healthUrl);
  const health = await healthResponse.json();

  const unauthorizedResponse = await fetch(handle.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });

  const authorizedMissingSessionResponse = await fetch(handle.url, {
    method: "POST",
    headers: {
      "authorization": "Bearer smoke-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const result = {
    healthStatus: healthResponse.status,
    healthOk: health.ok,
    root: health.root,
    unauthorizedStatus: unauthorizedResponse.status,
    authorizedMissingSessionStatus: authorizedMissingSessionResponse.status,
  };
  console.log(JSON.stringify(result, null, 2));

  if (healthResponse.status !== 200 || health.ok !== true) {
    throw new Error("Health smoke failed.");
  }
  if (unauthorizedResponse.status !== 401) {
    throw new Error("Bearer token smoke failed.");
  }
  if (authorizedMissingSessionResponse.status !== 400) {
    throw new Error("MCP endpoint smoke failed.");
  }
} finally {
  await handle.close();
}
