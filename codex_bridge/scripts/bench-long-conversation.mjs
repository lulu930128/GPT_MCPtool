// Run from the component root. All records and identities are synthetic.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, open, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const [build = "dist", mode, root] = process.argv.slice(2);
const moduleUrl = name => pathToFileURL(resolve(build, "src", name + ".js")).href;
const revisions = 17400, at = "2026-11-25T00:00:00.000Z";
if (mode === "worker" || mode === "rollback") {
  assert.equal(await fs.readFile(join(root,".fixture-id"),"utf8"),process.argv[6]);
}
if (mode === "rollback") {
  const { JobStore } = await import(moduleUrl("job-store"));
  const store = new JobStore(root);
  await store.initialize();
  const checks = JSON.parse(await fs.readFile(join(root,".fixture-checks"),"utf8"));
  for (const expected of checks) {
    const record = store.findByThreadId(expected.thread);
    assert.equal(record.id,expected.jobId);
    assert.equal(record.turnId,expected.turnId);
    const view = await store.snapshot(record.id,expected.eventSeq);
    assert.equal(view.nextConversationRevision,expected.revision);
    assert.equal(view.serverLastEventSeq,expected.eventSeq+1); // Previous owner records its restart interruption.
    const text = (expected.turnIds ?? [record.turnId]).map(turnId=>view.conversation.turns.find(t=>t.turnId===turnId).items.find(i=>i.id==="bench").text).join("");
    assert.equal(createHash("sha256").update(text).digest("hex"),expected.textSha256);
  }
  console.log(JSON.stringify({rollbackBuild:build,jobsVerified:checks.length}));
} else if (mode !== "worker") {
  const dir = await mkdtemp(join(tmpdir(), "bridge-long-"));
  try {
    const nonce = randomUUID();
    await writeFile(join(dir,".fixture-id"),nonce);
    const archives = Number(process.env.BRIDGE_BENCH_ARCHIVES ?? 0);
    assert(Number.isSafeInteger(archives) && archives >= 0);
    for (let n = 0; n < 3; n++) {
      const id = randomUUID(), job = join(dir, id), threadId = "thread-" + n;
      await mkdir(job);
      const count = n === 0 ? revisions : 600;
      const width = n === 0 ? 12500 : 400;
      const items = [];
      const journal = await open(join(job, "conversation-events.jsonl"), "wx");
      const events = await open(join(job, "events.jsonl"), "wx");
      try {
        let lines = "", eventLines = "";
        for (let revision = 1; revision <= count; revision++) {
          const index = Math.min(revision - 1, n === 0 ? 389 : 15);
          const item = { id: "item-" + index, turnId: "turn-" + n, type: "agentMessage",
            text: String(revision).padEnd(width, "x"), timestampSource: "live", status: "completed", isStreaming: false };
          items[index] = item;
          lines += JSON.stringify({ at, revision, threadId, turns: [{ turnId: item.turnId, status: "inProgress", items: [item] }] }) + "\n";
          eventLines += JSON.stringify({ seq: revision, at, type: "fixture", message: "e".repeat(360) }) + "\n";
          if (lines.length > 1_000_000 || revision === count) {
            await journal.writeFile(lines); await events.writeFile(eventLines); lines = ""; eventLines = "";
          }
        }
      } finally { await journal.close(); await events.close(); }
      const checkpoint = JSON.stringify({ schemaVersion: 1, threadId, status: "active", revision: count, updatedAt: at,
        turns: [{ turnId: "turn-" + n, status: "inProgress", items }] });
      await writeFile(join(job, "conversation.json"), checkpoint);
      await writeFile(join(job, "conversation.json.bak"), checkpoint);
      await writeFile(join(job, "messages.jsonl"), "");
      await writeFile(join(job, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, threadId, turnId: "turn-" + n,
        status: "running", project: { id: "fixture", name: "fixture", path: dir },
        workPackage: { title: "synthetic", objective: "synthetic", dataClassification: "personal" },
        idempotencyKey: id, approvals: [], createdAt: at, updatedAt: at, lastEventSeq: count, stateVersion: 1 }));
      if (!n) for (let archive = 0; archive < archives; archive++) {
        const cold = randomUUID(), path = join(dir,cold);
        await mkdir(path);
        const manifest = JSON.parse(await fs.readFile(join(job,"manifest.json"),"utf8"));
        await writeFile(join(path,"manifest.json"), JSON.stringify({...manifest,id:cold,idempotencyKey:cold,threadId:"archive-"+archive,status:"completed"}));
        const projection = JSON.parse(checkpoint);
        projection.threadId = "archive-"+archive;
        await writeFile(join(path,"conversation.json"), JSON.stringify(projection));
        await writeFile(join(path,"conversation.json.bak"), JSON.stringify(projection));
        await writeFile(join(path,"messages.jsonl"), "");
        await writeFile(join(path,"events.jsonl"), "");
      }
      if (!n) console.log(JSON.stringify({ fixture: Object.fromEntries(await Promise.all(["conversation-events.jsonl",
        "conversation.json", "events.jsonl"].map(async f => [f, (await stat(join(job, f))).size]))), revisions }));
    }
    const child = spawnSync(process.execPath, ["--expose-gc", import.meta.filename, build, "worker", dir, mode ?? "off", nonce],
      { stdio: "inherit" });
    process.exitCode = child.status ?? 1;
    if (!process.exitCode && process.env.BRIDGE_BENCH_ROLLBACK_BUILD) {
      const rollback = spawnSync(process.execPath,[import.meta.filename,process.env.BRIDGE_BENCH_ROLLBACK_BUILD,"rollback",dir,"off",nonce],{stdio:"inherit"});
      process.exitCode = rollback.status ?? 1;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  // Count application writes before importing JobStore, including repeated checkpoint replacements.
  let written = 0;
  const measureWrite = (object, key, index) => {
    const original = object[key];
    object[key] = function(...args) { written += Buffer.byteLength(args[index]); return original.apply(this, args); };
  };
  for (const key of ["appendFile", "writeFile"]) measureWrite(fs, key, 1);
  const openFile = fs.open;
  fs.open = async (...args) => { const fd = await openFile(...args); measureWrite(fd, "writeFile", 0); return fd; };
  syncBuiltinESMExports();
  const { JobStore } = await import(moduleUrl("job-store"));
  const { RuntimeDiagnostics } = await import(moduleUrl("runtime-diagnostics"));
  const diag = process.argv[5] === "on" ? new RuntimeDiagnostics({dataDir:root, projectRoot:process.cwd(), buildId:"fixture"}) : undefined;
  const store = new JobStore(root, undefined, undefined, diag);
  if (diag && store.workload) diag.workload = () => ({store:store.workload()});
  let gcMs = 0, gcCount = 0;
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcMs += entry.duration; gcCount++; } });
  observer.observe({entryTypes:["gc"]});
  const cpu = process.cpuUsage(), start = performance.now();
  await store.initialize();
  const bootMs = performance.now() - start, bootMemory = process.memoryUsage();
  const all = store.listAll();
  const ids = all.filter(j => j.status === "interrupted").map(j => j.id);
  assert.equal(ids.length,3);
  const checks = [];
  const batches = Number(process.env.BRIDGE_BENCH_BATCHES ?? 12);
  assert(Number.isSafeInteger(batches) && batches > 0);
  const turnRounds = Number(process.env.BRIDGE_BENCH_ROUNDS_PER_TURN ?? 0);
  assert(Number.isSafeInteger(turnRounds) && turnRounds >= 0);
  const intervalMs = Number(process.env.BRIDGE_BENCH_INTERVAL_MS ?? 0);
  assert(Number.isSafeInteger(intervalMs) && intervalMs >= 0);
  const samples = [];
  const sample = () => samples.push({elapsedMs:performance.now()-start,...process.memoryUsage(),gcCount,gcMs});
  const sampler = setInterval(sample,60000);
  const snapshotMs = [], deltaMs = [], commitMs = [], queueMs = [];
  let received = 0;
  const diagnosticBytesBefore = diag ? (await stat(diag.path)).size : 0;
  await Promise.all(ids.map(async id => {
    const record = store.get(id);
    await store.setTurn(id, record.turnId);
    let t = performance.now();
    let view = await store.snapshot(id, record.lastEventSeq);
    snapshotMs.push(performance.now() - t);
    assert.equal(view.conversation.threadId, record.threadId);
    const turnIds = [record.turnId];
    for (let round = 0; round < batches; round++) {
      if (round && turnRounds && round % turnRounds === 0) {
        await store.applyConversationNotification(id,{method:"turn/completed",params:{threadId:record.threadId,turn:{id:turnIds.at(-1),status:"completed"}}},at);
        const next = record.turnId + "-" + turnIds.length;
        await store.setTurn(id,next);
        await store.applyConversationNotification(id,{method:"turn/started",params:{threadId:record.threadId,turn:{id:next,status:"inProgress"}}},at);
        turnIds.push(next);
      }
      const revision = view.nextConversationRevision;
      t = performance.now();
      await Promise.all(Array.from({length:16}, async (_, i) => {
        const before = performance.now();
        await store.applyConversationNotification(id, {method:"item/agentMessage/delta",
          params:{threadId:record.threadId, turnId:turnIds.at(-1), itemId:"bench", delta:"d"+round+"-"+i+" "}}, at, true, false);
        queueMs.push(performance.now() - before);
        received++;
      }));
      await store.flushConversation(id);
      commitMs.push(performance.now() - t);
      t = performance.now();
      view = await store.snapshot(id, view.nextEventSeq, 20, revision);
      deltaMs.push(performance.now() - t);
      assert(view.nextConversationRevision > revision);
      if (intervalMs) await new Promise(done=>setTimeout(done,intervalMs));
    }
    const final = await store.snapshot(id,view.nextEventSeq);
    const text = turnIds.map(turnId=>final.conversation.turns.find(t=>t.turnId===turnId).items.find(i=>i.id==="bench").text).join("");
    const expected = Array.from({length:batches},(_,r)=> Array.from({length:16},(_,i)=>"d"+r+"-"+i+" ").join("")).join("");
    assert.equal(text,!turnRounds && expected.length > 100000 ? expected.slice(0,100000)+"\n[truncated]" : expected);
    checks.push({jobId:record.id,turnId:turnIds.at(-1),turnIds,thread:record.threadId, revision:final.nextConversationRevision, eventSeq:final.nextEventSeq,
      textSha256:createHash("sha256").update(text).digest("hex")});
  }));
  clearInterval(sampler);
  sample();
  if (diag) diag.record("heartbeat");
  const diagnosticBytes = diag ? (await stat(diag.path)).size - diagnosticBytesBefore : 0;
  diag?.dispose();
  const workMs = performance.now() - start - bootMs, endMemory = process.memoryUsage();
  global.gc(); await new Promise(r => setImmediate(r)); observer.disconnect();
  const p95 = arr => arr.sort((a,b)=>a-b)[Math.ceil(arr.length*.95)-1];
  if (process.env.BRIDGE_BENCH_ROLLBACK_BUILD) await fs.writeFile(join(root,".fixture-checks"), JSON.stringify(checks));
  console.log(JSON.stringify({build, jobs:ids.length, archives:all.length-ids.length,batches, diagnosticBytes,checks:checks.sort((a,b)=>a.thread.localeCompare(b.thread)), received, bootMs, bootMemory, workMs, intervalMs, samples,
    notificationsPerSecond:received*1000/workMs, snapshotP95:p95(snapshotMs), deltaP95:p95(deltaMs),
    enqueueToAppliedP95:p95(queueMs), batchToCommitP95:p95(commitMs), applicationWriteBytes:written, cpu:process.cpuUsage(cpu),
    gcCount,gcMs,endMemory, postGcMemory:process.memoryUsage(), peakRssKiB:process.resourceUsage().maxRSS}));
}
