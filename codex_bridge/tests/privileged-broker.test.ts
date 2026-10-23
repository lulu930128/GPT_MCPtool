import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, appendFile, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemotePrivilegedBroker, type SyntheticDelivery, type SyntheticWorker } from "../src/privileged/broker.js";
import { BrokerError, MAX_REQUESTS, TTL_MS, type BrokerReceipt } from "../src/privileged/contract.js";
import { SyntheticReceiptStore } from "../src/privileged/receipt-store.js";

const operationId = "diagnostics.os_summary";
const proposal = () => ({ operationId, requestId: randomUUID() });
const decision = (receipt: BrokerReceipt, value: "approve" | "deny" = "approve") => ({
  requestId: receipt.requestId, approvalId: receipt.approvalId, digest: receipt.digest, decision: value,
});
function completed(delivery: SyntheticDelivery) {
  const { requestId, approvalId, bootId, digest, evidence } = delivery;
  return { evidence, requestId, approvalId, bootId, digest, result: delivery.operationId === operationId
    ? { operationId, data: { platform: "windows", architecture: "x64" } }
    : { operationId: delivery.operationId, data: { totalMiB: 16384, availableMiB: 8192 } } };
}
const code = (expected: string) => (error: unknown) => error instanceof BrokerError && error.code === expected;

async function fixture(t: TestContext, worker?: SyntheticWorker, extras: { clock?: () => number; timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-privileged-synthetic-"));
  const directory = join(root, "broker");
  const handles: Awaited<ReturnType<typeof RemotePrivilegedBroker.syntheticFixture>>[] = [];
  t.after(async () => {
    for (const handle of handles) await handle.broker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const handle = await RemotePrivilegedBroker.syntheticFixture({ directory, worker, ...extras });
    handles.push(handle);
    return handle;
  };
  return { root, directory, open, ...await open() };
}

test("default broker is NOT DEPLOYED/NOT ENFORCED, dry-run only and has no public approval method", async () => {
  const broker = RemotePrivilegedBroker.notConfigured();
  const status = broker.status();
  assert.equal(status.enabled, false);
  assert.equal(status.deployment, "NOT DEPLOYED");
  assert.equal(status.writeProtection, "NOT ENFORCED");
  assert.equal(status.dataPlane, "disabled");
  const preview = broker.preview({ operationId });
  assert.equal(preview.mode, "dry_run");
  assert.equal(preview.state, "not_configured");
  assert.equal(preview.execution, "not_executed");
  assert.equal(preview.createsRequest, false);
  assert.equal(preview.policy.requiredPrivilege, "standard_user");
  assert.equal(preview.policy.mutationEnabled, false);
  await assert.rejects(broker.request(proposal()), code("BROKER_NOT_CONFIGURED"));
  await assert.rejects(broker.execute({ requestId: randomUUID() }), code("BROKER_NOT_CONFIGURED"));
  assert.equal("decide" in broker, false);
  assert.equal("approve" in broker, false);
});

test("closed enum policy rejects unknown/mutation operations and caller paths, commands, flags, env and forged approvals", async (t) => {
  const { broker } = await fixture(t);
  for (const operationId of ["shell", "powershell", "service.restart", "kgi.order", "__proto__", "diagnostics.os_summary --admin"]) {
    assert.throws(() => broker.preview({ operationId }), code("BROKER_INVALID_INPUT"));
    await assert.rejects(broker.request({ ...proposal(), operationId }), code("BROKER_INVALID_INPUT"));
  }
  for (const key of ["path", "command", "flags", "env", "target", "cwd", "projectId", "approval", "approved", "source", "ttl", "executor", "__proto__"]) {
    const extra = JSON.parse(JSON.stringify({ [key]: "untrusted-input" }));
    assert.throws(() => broker.preview({ operationId, ...extra }), code("BROKER_INVALID_INPUT"));
    await assert.rejects(broker.request({ ...proposal(), ...extra }), code("BROKER_INVALID_INPUT"));
  }
  for (const value of [null, [], "bad", {}, { requestId: "../../escape", operationId }]) {
    await assert.rejects(broker.request(value), code("BROKER_INVALID_INPUT"));
  }
});

test("full synthetic proposal/review/receipt flow is independent, least privilege and durable before delivery", async (t) => {
  let calls = 0;
  let journalPath = "";
  const f = await fixture(t, async (delivery) => {
    calls++;
    assert.equal(Object.isFrozen(delivery), true);
    assert.equal(delivery.targetId, "local_machine");
    assert.equal(delivery.requiredPrivilege, "standard_user");
    assert.deepEqual(Object.keys(delivery).sort(), ["evidence", "requestId", "approvalId", "bootId", "digest", "operationId", "targetId", "requiredPrivilege"].sort());
    const last = JSON.parse((await readFile(journalPath, "utf8")).trim().split("\n").at(-1)!);
    assert.equal(last.receipt.execution, "executing");
    assert.equal(last.receipt.approval, "approved");
    return completed(delivery);
  });
  journalPath = join(f.directory, "synthetic-receipts.jsonl");
  const pending = await f.broker.request(proposal());
  assert.equal(pending.approval, "pending");
  await assert.rejects(f.broker.execute({ requestId: pending.requestId }), code("BROKER_NOT_APPROVED"));
  assert.equal(calls, 0);
  const approved = await f.reviewer.decide(decision(pending));
  assert.equal(approved.approval, "approved");
  assert.equal(approved.execution, "not_executed");
  assert.equal(calls, 0, "Approval does not execute");
  const receipt = await f.broker.execute({ requestId: pending.requestId });
  assert.equal(receipt.execution, "executed");
  assert.equal(receipt.evidence, "SYNTHETIC_ONLY");
  assert.equal(receipt.result?.operationId, operationId);
  assert.equal(calls, 1);
  assert.deepEqual(await f.broker.get({ requestId: pending.requestId }), receipt);
  const memory = await f.broker.request({ operationId: "diagnostics.memory_summary", requestId: randomUUID() });
  await f.reviewer.decide(decision(memory));
  assert.equal((await f.broker.execute({ requestId: memory.requestId })).result?.operationId, "diagnostics.memory_summary");
});

test("exact id/digest approval, deny finality, unknown requests and no human boolean bypass", async (t) => {
  const { broker, reviewer } = await fixture(t, async (delivery) => completed(delivery));
  const pending = await broker.request(proposal());
  for (const change of [{ approvalId: randomUUID() }, { digest: "a".repeat(64) }]) {
    await assert.rejects(reviewer.decide({ ...decision(pending), ...change }), code("BROKER_APPROVAL_MISMATCH"));
  }
  await assert.rejects(reviewer.decide({ ...decision(pending), requestId: randomUUID() }), code("BROKER_REQUEST_UNKNOWN"));
  await assert.rejects(reviewer.decide({ ...decision(pending), human: true }), code("BROKER_INVALID_INPUT"));
  await reviewer.decide(decision(pending, "deny"));
  assert.equal((await reviewer.decide(decision(pending, "deny"))).approval, "denied");
  await assert.rejects(reviewer.decide(decision(pending)), code("BROKER_APPROVAL_CLOSED"));
  await assert.rejects(broker.execute({ requestId: pending.requestId }), code("BROKER_NOT_APPROVED"));
});

test("retry-stable request ids and concurrent execution deliver exactly once within the synthetic owner", async (t) => {
  let calls = 0;
  const { broker, reviewer } = await fixture(t, async (delivery) => { calls++; return completed(delivery); });
  const input = proposal();
  const requests = await Promise.all(Array.from({ length: 20 }, () => broker.request(input)));
  assert.equal(new Set(requests.map((receipt) => receipt.approvalId)).size, 1);
  await assert.rejects(broker.request({ ...input, operationId: "diagnostics.memory_summary" }), code("BROKER_REQUEST_CONFLICT"));
  await Promise.all(Array.from({ length: 20 }, () => reviewer.decide(decision(requests[0]))));
  const receipts = await Promise.all(Array.from({ length: 20 }, () => broker.execute({ requestId: input.requestId })));
  assert.ok(receipts.every((receipt) => receipt.execution === "executed"));
  assert.equal(calls, 1);
  const retry = await broker.request(input);
  assert.equal(retry.execution, "executed");
  retry.approval = "pending";
  assert.equal((await broker.get({ requestId: input.requestId })).approval, "approved", "Returned objects cannot mutate authority");
});

test("approve/deny race has one terminal decision; denied execution never runs", async (t) => {
  let calls = 0;
  const { broker, reviewer } = await fixture(t, async (delivery) => { calls++; return completed(delivery); });
  const receipt = await broker.request(proposal());
  const results = await Promise.allSettled([reviewer.decide(decision(receipt, "deny")), reviewer.decide(decision(receipt))]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  await assert.rejects(broker.execute({ requestId: receipt.requestId }), code("BROKER_NOT_APPROVED"));
  assert.equal(calls, 0);
});

test("TTL expires pending and approved requests at the boundary without reusing ids", async (t) => {
  let now = 1_000;
  let calls = 0;
  const { broker, reviewer } = await fixture(t, async (delivery) => { calls++; return completed(delivery); }, { clock: () => now });
  const first = await broker.request(proposal());
  const second = await broker.request(proposal());
  await reviewer.decide(decision(second));
  now += TTL_MS;
  await assert.rejects(reviewer.decide(decision(first)), code("BROKER_APPROVAL_CLOSED"));
  await assert.rejects(broker.execute({ requestId: second.requestId }), code("BROKER_NOT_APPROVED"));
  assert.equal((await broker.request({ requestId: first.requestId, operationId })).approval, "expired");
  assert.equal((await broker.get({ requestId: second.requestId })).reason, "TTL_EXPIRED");
  assert.equal(calls, 0);
});

test("clock rollback fails closed", async (t) => {
  let now = 1_000;
  const { broker, reviewer } = await fixture(t, undefined, { clock: () => now });
  const pending = await broker.request(proposal());
  now--;
  await assert.rejects(reviewer.decide(decision(pending)), code("BROKER_CLOCK_UNTRUSTED"));
});

test("restart expires pending/approved grants, retains completed result and preserves request-id tombstones", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (delivery) => { calls++; return completed(delivery); });
  const pending = await f.broker.request(proposal());
  const approved = await f.broker.request(proposal());
  const done = await f.broker.request(proposal());
  await f.reviewer.decide(decision(approved));
  await f.reviewer.decide(decision(done));
  await f.broker.execute({ requestId: done.requestId });
  await f.broker.close();
  const restarted = await f.open();
  for (const previous of [pending, approved]) {
    const receipt = await restarted.broker.request({ requestId: previous.requestId, operationId });
    assert.equal(receipt.approval, "expired");
    assert.equal(receipt.reason, "RESTART_EXPIRED");
    await assert.rejects(restarted.reviewer.decide(decision(previous)), code("BROKER_APPROVAL_MISMATCH"));
    await assert.rejects(restarted.broker.execute({ requestId: previous.requestId }), code("BROKER_NOT_APPROVED"));
  }
  assert.equal((await restarted.broker.execute({ requestId: done.requestId })).execution, "executed");
  assert.equal(calls, 1);
});

test("restart after durable delivery intent is unknown, never replayed", async (t) => {
  const f = await fixture(t);
  const receipt = await f.broker.request(proposal());
  const approved = await f.reviewer.decide(decision(receipt));
  await f.broker.close();
  const store = await SyntheticReceiptStore.open(f.directory);
  await store.append({ ...approved, execution: "executing", reason: "DELIVERY_STARTED" });
  await store.close();
  const restarted = await f.open();
  const unknown = await restarted.broker.execute({ requestId: receipt.requestId });
  assert.equal(unknown.execution, "unknown");
  assert.equal(unknown.reason, "RESTART_UNCERTAIN");
});

test("approved without worker is not_executed, not a successful execution", async (t) => {
  const { broker, reviewer } = await fixture(t);
  const receipt = await broker.request(proposal());
  await reviewer.decide(decision(receipt));
  await assert.rejects(broker.execute({ requestId: receipt.requestId }), code("BROKER_WORKER_NOT_CONFIGURED"));
  assert.equal((await broker.get({ requestId: receipt.requestId })).execution, "not_executed");
});

test("worker failure and timeout stay unknown with no raw error leakage or retry", async (t) => {
  for (const timeout of [false, true]) {
    let calls = 0;
    let release: ((value: unknown) => void) | undefined;
    let delivered: SyntheticDelivery | undefined;
    const f = await fixture(t, async (delivery) => {
      calls++;
      delivered = delivery;
      if (timeout) return new Promise((resolve) => { release = resolve; });
      throw new Error("Bearer private-sensitive-output C:\\secret\\credential");
    }, { timeoutMs: 10 });
    const pending = await f.broker.request(proposal());
    await f.reviewer.decide(decision(pending));
    const unknown = await f.broker.execute({ requestId: pending.requestId });
    assert.equal(unknown.execution, "unknown");
    if (release) release(completed(delivered!));
    assert.equal((await f.broker.execute({ requestId: pending.requestId })).execution, "unknown");
    assert.equal(calls, 1);
    assert.doesNotMatch(await readFile(join(f.directory, "synthetic-receipts.jsonl"), "utf8"), /Bearer|private-sensitive|credential/);
  }
});

test("result allowlist rejects secrets, raw output, identity mismatch and wrong operation before persistence", async (t) => {
  const badResults = [
    (d: SyntheticDelivery) => ({ ...completed(d), token: "sensitive-sentinel" }),
    (d: SyntheticDelivery) => ({ ...completed(d), result: { operationId, data: { platform: "windows", architecture: "x64", stdout: "sensitive-sentinel" } } }),
    (d: SyntheticDelivery) => ({ ...completed(d), result: { operationId, data: { platform: "sensitive-sentinel", architecture: "x64" } } }),
    (d: SyntheticDelivery) => ({ ...completed(d), requestId: randomUUID() }),
    (d: SyntheticDelivery) => ({ ...completed(d), digest: "0".repeat(64) }),
    (d: SyntheticDelivery) => ({ ...completed(d), result: { operationId: "diagnostics.memory_summary", data: { totalMiB: 10, availableMiB: 11 } } }),
    (d: SyntheticDelivery) => ({ ...completed(d), result: { operationId: "diagnostics.memory_summary", data: { totalMiB: 100, availableMiB: 50 } } }),
  ];
  for (const corrupt of badResults) {
    const f = await fixture(t, async (delivery) => corrupt(delivery));
    const pending = await f.broker.request(proposal());
    await f.reviewer.decide(decision(pending));
    const receipt = await f.broker.execute({ requestId: pending.requestId });
    assert.equal(receipt.execution, "unknown");
    assert.equal(receipt.reason, "RESULT_REJECTED");
    assert.equal(receipt.result, undefined);
    assert.doesNotMatch(await readFile(join(f.directory, "synthetic-receipts.jsonl"), "utf8"), /sensitive-sentinel|stdout|token/);
  }
});

test("different stores cannot approve each other's requests and a second owner cannot open a locked store", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const pending = await first.broker.request(proposal());
  await assert.rejects(second.reviewer.decide(decision(pending)), code("BROKER_REQUEST_UNKNOWN"));
  await assert.rejects(first.open(), code("BROKER_STORE_LOCKED"));
  assert.equal((await first.broker.get({ requestId: pending.requestId })).approval, "pending");
});

test("abandoned lock and damaged journal fail closed without repairing or discarding evidence", async (t) => {
  const f = await fixture(t);
  await f.broker.request(proposal());
  await f.broker.close();
  await appendFile(join(f.directory, "synthetic-receipts.jsonl"), '{"partial":');
  const before = await readFile(join(f.directory, "synthetic-receipts.jsonl"), "utf8");
  await assert.rejects(f.open(), code("BROKER_STORE_CORRUPT"));
  assert.equal(await readFile(join(f.directory, "synthetic-receipts.jsonl"), "utf8"), before);
  const locked = join(f.root, "abandoned");
  await mkdir(locked);
  await writeFile(join(locked, "synthetic-broker.lock"), "");
  await assert.rejects(RemotePrivilegedBroker.syntheticFixture({ directory: locked }), code("BROKER_STORE_LOCKED"));
});

test("bounded receipt capacity rejects new ids and retains old retry identities", async (t) => {
  const { broker } = await fixture(t, undefined, { clock: () => 1_000 });
  const input = proposal();
  await broker.request(input);
  for (let index = 1; index < MAX_REQUESTS; index++) await broker.request(proposal());
  await assert.rejects(broker.request(proposal()), code("BROKER_STORE_CAPACITY"));
  assert.equal((await broker.request(input)).requestId, input.requestId);
});

test("fsync failure before delivery blocks the worker and poisons the store without leaking filesystem errors", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (delivery) => { calls++; return completed(delivery); });
  const pending = await f.broker.request(proposal());
  await f.reviewer.decide(decision(pending));
  const probe = await open(join(f.root, "sync-probe"), "w");
  const sync = t.mock.method(Object.getPrototypeOf(probe), "sync", async () => { throw new Error("private-fs-error"); });
  try {
    await assert.rejects(f.broker.execute({ requestId: pending.requestId }), code("BROKER_PERSISTENCE_UNCERTAIN"));
    assert.equal(calls, 0);
    await assert.rejects(f.broker.get({ requestId: pending.requestId }), code("BROKER_STORE_UNAVAILABLE"));
  } finally { sync.mock.restore(); await probe.close(); }
  await f.broker.close();
  await assert.rejects(f.open(), code("BROKER_STORE_LOCKED"));
  assert.doesNotMatch(await readFile(join(f.directory, "synthetic-receipts.jsonl"), "utf8"), /private-fs-error/);
});

test("failure persisting completion never redelivers and retains the failed-write lock", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (delivery) => { calls++; return completed(delivery); });
  const pending = await f.broker.request(proposal());
  await f.reviewer.decide(decision(pending));
  const probe = await open(join(f.root, "sync-probe"), "w");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.sync;
  let syncCalls = 0;
  const sync = t.mock.method(prototype, "sync", async function(this: unknown) {
    if (++syncCalls === 2) throw new Error("private-result-write-error");
    return original.call(this);
  });
  try {
    await assert.rejects(f.broker.execute({ requestId: pending.requestId }), code("BROKER_PERSISTENCE_UNCERTAIN"));
    await assert.rejects(f.broker.execute({ requestId: pending.requestId }), code("BROKER_STORE_UNAVAILABLE"));
    assert.equal(calls, 1);
  } finally { sync.mock.restore(); await probe.close(); }
  await f.broker.close();
  await assert.rejects(f.open(), code("BROKER_STORE_LOCKED"));
});

test("approval expiring during durable intent never reaches the worker", async (t) => {
  let now = 1_000;
  let calls = 0;
  const f = await fixture(t, async (delivery) => { calls++; return completed(delivery); }, { clock: () => now });
  const pending = await f.broker.request(proposal());
  await f.reviewer.decide(decision(pending));
  const prototype = SyntheticReceiptStore.prototype;
  const original = prototype.append;
  const append = t.mock.method(prototype, "append", async function(this: SyntheticReceiptStore, receipt: BrokerReceipt) {
    await original.call(this, receipt);
    if (receipt.execution === "executing") now += TTL_MS;
  });
  try {
    const receipt = await f.broker.execute({ requestId: pending.requestId });
    assert.equal(receipt.execution, "unknown", "Durable intent is retained conservatively");
    assert.equal(calls, 0);
  } finally { append.mock.restore(); }
});
