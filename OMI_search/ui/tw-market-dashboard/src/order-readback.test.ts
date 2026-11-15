import assert from "node:assert/strict";
import test from "node:test";
import { deskOrderRead, protectionRequestObserved } from "./desk-contract";

const data = { market: "US", execution: { execution_id: "order-1", state: "FILLED" },
  protection: { entry_execution_id: "order-1", strategy_id: "strategy-1", strategy_revision: 5, rules: {}, audit: [
    { kind: "STRATEGY_REVISED", payload: { request_id: "request-1", strategy_id: "strategy-1", strategy_revision: 4 } },
  ] } };
const request = { request_id: "request-1", expected_revision: 3, strategy_id: "strategy-1" };
test("single order controls reject another order, market or protection owner", () => {
  assert.equal(deskOrderRead(data, "order-1", "US"), data);
  assert.throws(() => deskOrderRead(data, "other", "US"));
  assert.throws(() => deskOrderRead(data, "order-1", "TW"));
  assert.throws(() => deskOrderRead({ ...data, protection: { ...data.protection, entry_execution_id: "other" } }, "order-1", "US"));
});
test("newer protection revision alone never acknowledges this request", () => {
  assert.equal(protectionRequestObserved(data, request), true);
  assert.equal(protectionRequestObserved({ ...data, protection: { ...data.protection, audit: [] } }, request), false);
  assert.equal(protectionRequestObserved(data, { ...request, request_id: "old-request" }), false);
  assert.equal(protectionRequestObserved(data, { ...request, strategy_id: "other" }), false);
  assert.equal(protectionRequestObserved(data, { ...request, expected_revision: 4 }), false);
});
