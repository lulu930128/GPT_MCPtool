import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { toolValue, CallError } from "./candidate-state";
import { stageNotAttempted, sameStagedSelection, stageSelection } from "./desk-contract";
import { fixtureStage } from "../scripts/desk-fixture";

// Exercise HTTPError -> _api_request -> registered official MCP -> toolValue.
// The Python fixture mocks urlopen, so this cannot contact a runtime or broker.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = spawnSync(`${root}.venv/Scripts/python.exe`, ["-B", "tests/submission_attempt_fixture.py"], {
  cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000,
  env: { ...process.env, OMI_SEARCH_AI_TRUST_TOKEN: "" },
});
assert.equal(run.status, 0, run.stderr);
export const attemptWire = JSON.parse(run.stdout);
const row: any = { ...fixtureStage({ symbol: "3711", lot: "Odd", quantity_shares: 200, price: "592" }), id: "fixture-stage-3711" };
const pin = stageSelection(row);
const decoded = (wire = attemptWire): CallError => {
  try { toolValue(wire); } catch (error) { assert.ok(error instanceof CallError); return error; }
  throw Error("Expected MCP error");
};

test("real HTTP error/MCP/toolValue path retains typed detail and exact selector", () => {
  const error = decoded();
  assert.equal(error.httpStatus, 503);
  assert.deepEqual(error.backendError, attemptWire.structuredContent.backend_error);
  assert.equal(stageNotAttempted(error, pin), true);
  const textOnly = { isError: true, content: attemptWire.content };
  assert.equal(stageNotAttempted(decoded(textOnly), pin), true);
  assert.equal(sameStagedSelection(row, pin), row);
});

test("typed receipt never follows error-message text or a successful result", () => {
  assert.equal(stageNotAttempted(Error(JSON.stringify(attemptWire)), pin), false);
  assert.equal(stageNotAttempted(new CallError("OMI API HTTP 503: NOT_ATTEMPTED"), pin), false);
  assert.equal(stageNotAttempted(toolValue({ structuredContent: attemptWire.structuredContent }), pin), false);
});

for (const [label, mutate] of Object.entries<(value: any) => void>({
  "status": value => value.http_status = 409,
  "tool": value => value.tool = "omi_read_desk_stage",
  "policy": value => value.backend_error.error.detail.retry_policy = "CHECK_STATUS_DO_NOT_RESEND",
  "contract": value => value.backend_error.error.detail.submission_attempt.contract = "unknown",
  "unknown outcome": value => value.backend_error.error.detail.submission_attempt.outcome = "UNKNOWN",
  "phase": value => value.backend_error.error.detail.submission_attempt.phase = "CONFIRM",
  "started": value => value.backend_error.error.detail.submission_attempt.native_command_started = true,
  "malformed started": value => value.backend_error.error.detail.submission_attempt.native_command_started = "false",
  "ID": value => value.backend_error.error.detail.submission_attempt.candidate_id = "another-stage",
  "revision": value => value.backend_error.error.detail.submission_attempt.candidate_revision = 2,
  "revision type": value => value.backend_error.error.detail.submission_attempt.candidate_revision = "1",
  "digest": value => value.backend_error.error.detail.submission_attempt.candidate_digest = "c".repeat(64),
  "missing receipt": value => delete value.backend_error.error.detail.submission_attempt,
  "missing request ID": value => delete value.backend_error.error.request_id,
  "obsolete FastAPI envelope": value => value.backend_error = { detail: { code: value.backend_error.error.code, ...value.backend_error.error.detail } },
  "malformed envelope": value => value.backend_error = "NOT_ATTEMPTED",
})) test(`receipt rejects ${label}`, () => {
  const value = structuredClone(attemptWire.structuredContent); mutate(value);
  assert.equal(stageNotAttempted(decoded({ isError: true, structuredContent: value }), pin), false);
});

test("readback must remain exact ACTIVE/STAGED with no submission after receipt", () => {
  for (const patch of [{ id: "other" }, { revision: 2 }, { digest: "c".repeat(64) }, { state: "PAUSED" },
    { lifecycle: "SUBMITTING" }, { lifecycle: "PARTIALLY_FILLED" },
    { manual_stage: { ...(row.manual_stage as any), submission: { phase: "DRAFT" } } }]) {
    assert.throws(() => sameStagedSelection({ ...row, ...patch }, pin));
  }
});

test("actual Backend exception/context handler ASGI output traverses adapter/MCP/toolValue", { skip: !process.env.OMI_TEST_ASGI_FIXTURE }, () => {
  const asgi = JSON.parse(readFileSync(process.env.OMI_TEST_ASGI_FIXTURE!, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(asgi.status, 503); assert.equal(asgi.body.error.request_id, asgi.request_id);
  const wire = spawnSync(`${root}.venv/Scripts/python.exe`, ["-B", "tests/submission_attempt_fixture.py", "--stdin"], {
    cwd: root, input: JSON.stringify(asgi.body), encoding: "utf8", windowsHide: true, timeout: 20_000,
    env: { ...process.env, OMI_SEARCH_AI_TRUST_TOKEN: "" },
  });
  assert.equal(wire.status, 0, wire.stderr);
  const error = decoded(JSON.parse(wire.stdout));
  assert.deepEqual(error.backendError, asgi.body); assert.equal(stageNotAttempted(error, pin), true);
});
