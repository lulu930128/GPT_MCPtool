import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { initializePowerShellReview } from "../src/powershell-approval/review-runtime.js";

test("daily journal fault remains visible and preserves actual Store input bytes on repeated startup", async () => {
  const base = resolve(".tmp/daily-store-tests"); await mkdir(base, { recursive: true });
  const data = await mkdtemp(join(base, "fault-")), directory = join(data, "powershell-approval");
  await mkdir(directory);
  const path = join(directory, "receipts.jsonl"), bytes = Buffer.from('{"revision":\xff', "latin1");
  await writeFile(path, bytes);
  for (let attempt = 0; attempt < 2; attempt++) {
    const review = await initializePowerShellReview(data);
    assert.equal(review.approvalStore, undefined);
    const diagnostic = await review.reviewStoreDiagnostics();
    assert.equal(diagnostic.startup.status, "FAILED");
    assert.equal(diagnostic.startup.errorCode, "STORE_CORRUPT");
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(access(join(directory, "approval.lock")), { code: "ENOENT" });
  }
});

test("normal Store close releases its own lock and supports repeated same-boot opens", async () => {
  const base = resolve(".tmp/daily-store-tests"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "close-"));
  for (let attempt = 0; attempt < 3; attempt++) {
    const store = await ApprovalStore.open(directory);
    assert.equal((await store.lockDiagnostics()).owner, "THIS_INSTANCE");
    await store.close();
    await assert.rejects(access(join(directory, "approval.lock")), { code: "ENOENT" });
  }
});
