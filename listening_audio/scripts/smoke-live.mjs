import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { startHttpServer } from "../dist/src/http-server.js";
import { validateWav } from "../dist/src/trainer-client.js";

if (process.env.LISTENING_ALLOW_TEST_WRITE !== "1" || !process.env.LISTENING_TRAINER_ROOT || !process.env.LISTENING_TRAINER_PYTHON) {
  throw new Error("Set LISTENING_ALLOW_TEST_WRITE=1, LISTENING_TRAINER_ROOT and LISTENING_TRAINER_PYTHON. All test data stays under listening_audio/.tmp. Set LISTENING_LIVE_TTS=1 for real synthesis.");
}
const output = resolve(".tmp", `live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await mkdir(output, { recursive: true });
const root = resolve(process.env.LISTENING_TRAINER_ROOT);
const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
if (process.env.LISTENING_TEST_MALE_PORT) env.JLPT_TTS_MALE_PORT = process.env.LISTENING_TEST_MALE_PORT;
const child = spawn(process.env.LISTENING_TRAINER_PYTHON,
  ["-B", "-u", "scripts/isolated-trainer.py", "--root", root, "--data", output], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const exited = new Promise(resolve => child.once("exit", resolve));
const lines = createInterface({ input: child.stdout });
child.stderr.on("data", data => process.stderr.write(data));
let http, client;
const evidence = { output, liveTts: process.env.LISTENING_LIVE_TTS === "1", checks: [], audio: [] };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Trainer startup timeout")), 15000);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("Trainer exited before readiness")); });
    lines.on("line", line => {
      if (line.startsWith("LISTENING_READY ")) { clearTimeout(timer); resolve(JSON.parse(line.slice(16)).port); }
    });
  });
  http = await startHttpServer({ ...loadConfig({}), trainerBaseUrl: `http://127.0.0.1:${port}`, port: 0 });
  client = new Client({ name: "listening-live-smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 310000 });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.structuredContent;
  };
  const h = await call("listening_health", {});
  assert.equal(h.contractVersion, "listening-trainer-v1");
  const setId = "MCP-SMOKE-" + randomUUID();
  const linesByQuestion = [
    [{ seq: 1, speaker: "Man", voice_slot: "male", text: "明日の会議は午後三時からです。" }],
    [{ seq: 1, speaker: "Woman", voice_slot: "female", text: "明日の会議は午後三時からです。" }],
    [{ seq: 1, speaker: "Narrator", voice_slot: "narrator", text: "明日の会議は何時からですか。" },
     { seq: 2, speaker: "Woman", voice_slot: "female", text: "午後三時からです。" }]
  ];
  const set = { schema_version: "1.2", set_id: setId, level: "N3", question_count: 3, answer_sequence: [1, 2, 1],
    questions: linesByQuestion.map((script, index) => ({ id: `Q00${index + 1}`, level: "N3", type: "point_comprehension", topic: "company",
      question_ja: "会議は何時からですか。", question_zh_tw: "會議幾點開始？", audio_script: script,
      options: [1, 2, 3, 4].map(key => ({ key, text_ja: `${key + 1}時`, text_zh_tw: `${key + 1}點` })),
      correct_option: [1, 2, 1][index], explanation: { summary_zh_tw: "聽出會議時間。", evidence_ja: "午後三時からです。",
        evidence_zh_tw: "下午三點開始。", wrong_options: [], vocabulary: [], grammar: [], model_sentence: "午後三時からです。" } })) };
  // Keep each fixture answer consistent with its actual printed option order.
  set.questions[0].options = ["3時", "2時", "4時", "5時"].map((text_ja, i) => ({ key: i + 1, text_ja, text_zh_tw: text_ja.replace("時", "點") }));
  set.questions[2].options = structuredClone(set.questions[0].options);
  const created = await call("listening_create_exam", { set, language: "ja", presentation: "text_options" });
  assert.equal(created.reused, false);
  assert.equal((await call("listening_create_exam", { set })).reused, true);
  evidence.checks.push("real Trainer contract", "immutable import retry");
  for (const q of set.questions) {
    const args = { setId, questionId: q.id };
    const before = await call("listening_get_question", args);
    assert.equal(before.audio.state, "missing");
    for (const forbidden of ["audio_script", "correct_option", "explanation", "question_zh_tw"]) assert.ok(!JSON.stringify(before).includes(forbidden));
    if (!evidence.liveTts) continue;
    console.log(`Generating ${q.id}: ${q.audio_script.map(s => s.voice_slot).join("+")}`);
    const prepared = await call("listening_prepare_audio", args);
    assert.equal(prepared.audio.state, "ready");
    const result = await client.readResource({ uri: prepared.audio.resourceUri });
    const body = Buffer.from(result.contents[0].blob, "base64");
    validateWav(body);
    const path = join(output, `${q.id}.wav`); await writeFile(path, body);
    const cachePath = join(output, "audio", "listening-v1", setId, `${q.id}.wav`);
    const first = await stat(cachePath);
    await call("listening_prepare_audio", args);
    assert.equal((await stat(cachePath)).mtimeMs, first.mtimeMs);
    evidence.audio.push({ questionId: q.id, bytes: body.length, mimeType: result.contents[0].mimeType, path, cacheReused: true });
    console.log(`PASS ${q.id}: ${body.length} WAV bytes through resources/read; repeat reused cache.`);
  }
  const answer = { setId, attemptId: "attempt1", submissionId: "submission1", answers: { Q001: 1 } };
  const result = await call("listening_submit_answer", answer);
  assert.equal(result.score, 1); assert.equal(result.details.length, 1);
  assert.deepEqual(await call("listening_submit_answer", answer), result);
  evidence.checks.push("pre-answer safe projection", "partial answer only unlocks submitted question", "submission retry readback");
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS: isolated real Trainer smoke. Evidence: ${join(output, "evidence.json")}`);
} finally {
  await client?.close(); await http?.close();
  child.stdin.end();
  await exited;
  lines.close();
}
