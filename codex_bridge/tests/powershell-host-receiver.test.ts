import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { ApprovalError, sha256 } from "../src/powershell-approval/contract.js";
import { createPowerShellHostPort } from "../src/powershell-approval/host-admission.js";
import { createHostReceiver, HOST_RPC, hostInitialSchema } from "../src/powershell-approval/host-receiver.js";
import { createNativeHostTransport, observedNativeChannel } from "../src/powershell-approval/host-transport.js";

const code = (value: string) => (error: unknown) => error instanceof ApprovalError && error.code === value;
test("explicit preflight carries no review, candidate, authority or dispatch option", () => {
  const value = { contract: HOST_RPC, session: randomUUID(), expiresAt: Date.now() + 60_000, operation: "preflight" };
  assert.equal(hostInitialSchema.parse(value).operation, "preflight");
  for (const extra of [{ review: null }, { script: "inert" }, { accepted: true }, { executionMode: "NORMAL" }])
    assert.equal(hostInitialSchema.safeParse({ ...value, ...extra }).success, false);
  assert.equal(hostInitialSchema.safeParse({ ...value, operation: "review" }).success, false);
  assert.equal(hostInitialSchema.safeParse({ ...value, operation: "execute" }).success, false);
});
async function setup(t: TestContext) {
  const base = resolve(".tmp", "host-receiver-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")), store = await ApprovalStore.open(join(root, "approval"));
  t.after(() => store.close());
  const project = { id: "personal", name: "Personal", path: root };
  const port = createPowerShellHostPort({ store, projects: new Map([[project.id, project]]),
    readJob: async () => { throw new Error("DIRECT_MUST_NOT_READ_JOBSTORE"); } });
  const saved = await store.createReview({ origin: "DIRECT", projectId: "personal", dataClassification: "personal",
    idempotencyKey: randomUUID(), userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",
    target: "receiver source test", executionMode: "NORMAL", cwd: root,
    scriptSnapshot: "literal inert text\r\n中文", args: ["", "space value", "\\"], risk: "inert fixture", sideEffects: "none" });
  const review = { requestId: saved.request.requestId, digest: saved.digest };
  const receiver = createHostReceiver(port, review); t.after(() => receiver.close());
  const frame = (operation = "prepare", payload: unknown = review) => Buffer.from(JSON.stringify({ contract: HOST_RPC,
    session: receiver.session, channelBinding: "a".repeat(64), sequence: 1, expiresAt: receiver.expiresAt, message: { operation, payload } }));
  const journal = () => readFile(join(root, "approval", "receipts.jsonl"), "utf8");
  return { store, port, review, receiver, saved, frame, journal };
}

test("runtime HostPort snapshot and receipt read the exact single canonical Store", async t => {
  const f = await setup(t), before = await f.journal();
  const snapshot = await f.port.snapshot(f.review.requestId, f.review.digest);
  assert.equal(snapshot.requestJson, JSON.stringify(f.saved.request));
  assert.equal(sha256(snapshot.requestJson), f.review.digest);
  assert.deepEqual(JSON.parse(snapshot.requestJson).args, ["", "space value", "\\"]);
  assert.equal(JSON.parse(snapshot.requestJson).scriptSnapshot, "literal inert text\r\n中文");
  const receipt = await f.port.receipt(f.review.requestId);
  assert.equal(receipt.requestId, f.review.requestId);
  assert.equal(receipt.hostApproval.enabled, false);
  assert.equal(await f.journal(), before);
});

test("receiver refuses the first JSON binding and fabricated native capability before Store access", async t => {
  const f = await setup(t), before = await f.journal();
  for (const proof of [undefined, true, {}, { session: f.receiver.session, binding: "a".repeat(64), current: () => true },
    { source: "WINDOWS_HOST_PEER", pid: process.pid, sid: "S-1-5-21-1000", trusted: true }]) {
    await assert.rejects(f.receiver.receive(f.frame(), proof), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  }
  assert.equal(await f.journal(), before);
});

test("all fixed RPC operations refuse tool JSON; REVIEW_ACCEPTED grants no native channel", async t => {
  const f = await setup(t);
  await f.store.decideReview(f.review.requestId, f.review.digest, "ACCEPTED");
  const before = await f.journal();
  for (const op of ["prepare", "admit", "decide", "claim", "ingestNormal", "deliveryUncertain", "receipt", "execute", "ADMIN"]) {
    await assert.rejects(f.receiver.receive(f.frame(op), { accepted: true }), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  }
  assert.equal(f.store.listProduction().length, 0);
  assert.equal(await f.journal(), before);
});

test("untrusted frame replay, copied capability and another session never bind the receiver", async t => {
  const f = await setup(t), before = await f.journal(), bytes = f.frame();
  await assert.rejects(f.receiver.receive(bytes), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  await assert.rejects(f.receiver.receive(bytes), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  const fabricated = Object.freeze({ session: f.receiver.session, binding: "a".repeat(64) });
  assert.throws(() => observedNativeChannel(fabricated, f.receiver.session), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  assert.throws(() => observedNativeChannel(structuredClone(fabricated), randomUUID()), code("IPC_NATIVE_CHANNEL_REQUIRED"));
  assert.equal(await f.journal(), before);
});

test("closed receiver rejects late delivery; repeated close cannot create a production record", async t => {
  const f = await setup(t), before = await f.journal();
  await f.receiver.close(); await f.receiver.close();
  await assert.rejects(f.receiver.receive(f.frame()), code("HOST_SESSION_CLOSED_OR_BUSY"));
  assert.equal(await f.journal(), before);
});

test("Host snapshot checks digest, decline and TTL independently of transport", async t => {
  const f = await setup(t);
  await assert.rejects(f.port.snapshot(f.review.requestId, "b".repeat(64)), code("DIGEST_MISMATCH"));
  await f.store.decideReview(f.review.requestId, f.review.digest, "DECLINED");
  await assert.rejects(f.port.snapshot(f.review.requestId, f.review.digest), code("REVIEW_DECLINED"));
  t.mock.method(Date, "now", () => f.saved.request.expiresAt);
  await assert.rejects(f.port.snapshot(f.review.requestId, f.review.digest), code("TTL_EXPIRED"));
});

test("uninstalled transport remains passive; status and canonical prepare never create a child", async t => {
  const f = await setup(t), before = await f.journal();
  const transport = createNativeHostTransport(f.port);
  t.after(() => transport.close());
  assert.equal(transport.status().active, false);
  assert.equal((await transport.preflight()).code, "NOT_DEPLOYED");
  assert.equal((await transport.inspect(f.review.requestId, f.review.digest)).code, "NOT_DEPLOYED");
  assert.equal((await f.port.prepare(f.review.requestId, f.review.digest)).humanApproval, "AUTHENTICATED_DIRECT_REQUEST");
  assert.equal(await f.journal(), before);
});
