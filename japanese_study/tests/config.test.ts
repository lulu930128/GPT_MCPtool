import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";


test("defaults are private loopback endpoints", () => {
  const config = loadConfig({});
  assert.equal(config.hubBaseUrl, "http://127.0.0.1:8791");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8790);
});


test("non-loopback MCP bind requires a bearer token", () => {
  assert.throws(
    () => loadConfig({ JSTUDY_MCP_HOST: "0.0.0.0" }),
    /JSTUDY_MCP_HTTP_TOKEN/,
  );
});


test("remote Hub rejects cleartext HTTP", () => {
  assert.throws(
    () => loadConfig({ JSTUDY_HUB_BASE_URL: "http://study.example.test" }),
    /must use HTTPS/,
  );
});


test("credentials cannot be embedded in the Hub URL", () => {
  assert.throws(
    () => loadConfig({ JSTUDY_HUB_BASE_URL: "https://token@example.test" }),
    /Do not embed credentials/,
  );
});
