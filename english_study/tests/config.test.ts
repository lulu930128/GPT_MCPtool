import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("defaults are isolated loopback endpoints", () => {
  const config = loadConfig({});
  assert.equal(config.hubBaseUrl, "http://127.0.0.1:8831");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8830);
});

test("non-loopback MCP bind requires a token", () => {
  assert.throws(() => loadConfig({ ESTUDY_MCP_HOST: "0.0.0.0" }), /ESTUDY_MCP_HTTP_TOKEN/);
});

test("remote cleartext Hub and embedded credentials are rejected", () => {
  assert.throws(() => loadConfig({ ESTUDY_HUB_BASE_URL: "http://study.example.test" }), /must use HTTPS/);
  assert.throws(() => loadConfig({ ESTUDY_HUB_BASE_URL: "https://token@example.test" }), /Do not embed credentials/);
});
