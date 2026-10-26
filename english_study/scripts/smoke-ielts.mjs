import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startEnglishStudyHttpServer } from "../dist/src/http-server.js";
import { startHttpServer } from "../../listening_audio/dist/src/http-server.js";
import { loadConfig } from "../../listening_audio/dist/src/config.js";

for (const key of ["IELTS_HUB_ROOT", "IELTS_TRAINER_ROOT", "IELTS_TEST_PYTHON"]) if (!process.env[key]) throw Error(`Set ${key}; this smoke always uses disposable data.`);
const output = resolve(".tmp", `ielts-${Date.now()}`);
await mkdir(output, {recursive: true});
const child = spawn(process.env.IELTS_TEST_PYTHON, ["-B", "-u", "scripts/isolated-ielts-backends.py", "--hub-root", process.env.IELTS_HUB_ROOT,
  "--trainer-root", process.env.IELTS_TRAINER_ROOT, "--data", output], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {...process.env, PYTHONUTF8: "1"}});
const lines = createInterface({input: child.stdout});
const exited = new Promise(resolve => child.once("exit", resolve));
child.stderr.on("data", data => process.stderr.write(data));
const servers = [], clients = [];
const evidence = {checks: [], data: output, productionWrites: false, audioGenerated: false};
try {
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Isolated APIs startup timeout")), 15000);
    child.once("error", e => {clearTimeout(timer); reject(e);});
    child.once("exit", () => {clearTimeout(timer); reject(Error("Isolated APIs exited"));});
    lines.on("line", line => {if (line.startsWith("IELTS_READY ")) {clearTimeout(timer); resolve(JSON.parse(line.slice(12)));}});
  });
  const hub = await startEnglishStudyHttpServer({hubBaseUrl: `http://127.0.0.1:${ports.hubPort}`, hubTimeoutMs: 5000, host: "127.0.0.1", port: 0});
  servers.push(hub);
  const listening = await startHttpServer({...loadConfig({}), trainerBaseUrl: `http://127.0.0.1:${ports.trainerPort}`, port: 0});
  servers.push(listening);
  for (const server of servers) {
    const client = new Client({name: "ielts-regression", version: "2"});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  }
  const [english, audio] = clients;
  const call = async (client, name, args) => {
    const result = await client.callTool({name, arguments: args});
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.ok, true);
    return result.structuredContent;
  };
  assert.equal((await english.listTools()).tools.length, 17);
  assert.equal((await audio.listTools()).tools.length, 7);
  const essay = "Learning a language takes practice.\n".repeat(300);
  const assessment = {assessment_id: "assessment-writing-test", module: "academic", skill: "writing", scope: "task", question_keys: ["essay"],
    completeness: "complete", source_kind: "generated_practice", source_ref: "test-series", scoring_method: "model_estimate", assessor: "fixture-v1", estimated: true,
    overall_score: 5.5, rubric: {task_response: 5.5, coherence_cohesion: 5.5, lexical_resource: 5.5, grammatical_range_accuracy: 5.5},
    rubric_version: "ielts-writing-2023-estimate", metrics: {task_type: "task_2", word_count: 1800, duration_seconds: 1800},
    grading_policy_version: "fixture-v1", assessed_at: "2026-09-12T01:30:00Z"};
  const submission = {submissionId: "writing-submission-test", session: {sessionId: "writing-session-test", title: "Writing roundtrip", practiceType: "writing", startedAt: "2026-09-12T01:00:00Z", completedAt: "2026-09-12T01:30:00Z"},
    questions: [{questionKey: "essay", position: 1, prompt: "Discuss learning.", answer: {text: essay}, answerResult: "unscored", awardedPoints: 0, maxPoints: 0, submittedAt: "2026-09-12T01:30:00Z"}], assessments: [assessment]};
  const preview = await call(english, "english_preview_practice_record", {submission});
  await call(english, "english_record_practice", {submission, expectedFingerprint: preview.fingerprint});
  assert.equal((await call(english, "english_record_practice", {submission, expectedFingerprint: preview.fingerprint})).replayed, true);
  const detail = await call(english, "english_get_practice_session", {sessionId: "writing-session-test"});
  assert.equal(detail.session.questions[0].answer.text, essay);
  assert.equal(detail.session.assessments[0].overall_score, 5.5);
  assert.equal((await call(english, "english_list_practice_sessions", {skill: "writing"})).total, 1);
  const invalid = structuredClone(submission); invalid.assessments[0].overall_score = 5.3;
  assert.equal((await english.callTool({name: "english_preview_practice_record", arguments: {submission: invalid}})).isError, true);
  evidence.checks.push("17/7 MCP tools", "Writing essay and rubric roundtrip", "Writing replay", "invalid band rejected", "history filter");

  const kinds = ["single_choice", "multiple_choice", "text", "number", "matching"];
  const values = ["A", ["A", "C"], "environment", "7:30", {one: "A", two: "B"}];
  const questions = kinds.map((kind, i) => ({id: `Q${i+1}`, prompt: `Question ${i+1}`, section: 1, answer_type: kind,
    expected_answers: [{type: kind, value: values[i]}], explanation: "Check the recording.",
    audio_script: [{seq: 1, speaker: "Guide", voice_slot: "narrator", text: "The train leaves at seven thirty."}],
    ...(["single_choice", "multiple_choice", "matching"].includes(kind) ? {options: ["A", "B", "C"].map(key => ({key, text: key}))} : {}),
    ...(kind === "multiple_choice" ? {selection_count: 2} : {}), ...(kind === "matching" ? {matching_keys: ["one", "two"]} : {})}));
  const set = {schema_version: "2.0", set_id: "english-test", title: "English listening smoke", scope: "section", source_ref: "test-series", question_count: 5, questions};
  await call(audio, "listening_create_exam", {language: "en", set});
  const safe = await call(audio, "listening_get_question", {setId: set.set_id, questionId: "Q1"});
  assert.equal(safe.language, "en"); assert.ok(!JSON.stringify(safe).includes("expected"));
  const partial = await call(audio, "listening_submit_answer", {setId: set.set_id, attemptId: "try1", submissionId: "save1", answers: {Q1: {type: "single_choice", value: "A"}}});
  assert.equal(partial.status, "in_progress"); assert.equal(partial.details.length, 1);
  assert.equal((await english.callTool({name: "english_preview_practice_record", arguments: {listeningResult: partial}})).isError, true);
  const answers = Object.fromEntries(kinds.slice(1).map((kind, i) => [`Q${i+2}`, {type: kind, value: values[i+1]}]));
  const completed = await call(audio, "listening_submit_answer", {setId: set.set_id, attemptId: "try1", submissionId: "save2", answers, finalize: true});
  assert.equal(completed.rawScore, 7); assert.equal(completed.status, "completed");
  const recovered = await call(audio, "listening_get_attempt_result", {setId: set.set_id, attemptId: "try1"});
  const lp = await call(english, "english_preview_practice_record", {listeningResult: completed});
  const stored = await call(english, "english_record_practice", {listeningResult: completed, expectedFingerprint: lp.fingerprint});
  // Retry from a recovered result has no per-submission ID and must remain identical.
  const rp = await call(english, "english_preview_practice_record", {listeningResult: recovered});
  assert.equal(rp.fingerprint, lp.fingerprint);
  assert.equal((await call(english, "english_record_practice", {listeningResult: recovered, expectedFingerprint: rp.fingerprint})).replayed, true);
  const changedResult = structuredClone(recovered); changedResult.title = "Changed result";
  const changedPreview = await call(english, "english_preview_practice_record", {listeningResult: changedResult});
  const conflict = await english.callTool({name: "english_record_practice", arguments: {listeningResult: changedResult, expectedFingerprint: changedPreview.fingerprint}});
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.error.code, "IDEMPOTENCY_CONFLICT");
  const badTotals = structuredClone(recovered); badTotals.rawScore = 0;
  assert.equal((await english.callTool({name: "english_preview_practice_record", arguments: {listeningResult: badTotals}})).isError, true);
  const readback = await call(english, "english_get_practice_session", {sessionId: stored.session_id});
  assert.equal(readback.session.source.attempt_id, "try1");
  assert.equal(readback.session.assessments[0].metrics.raw_score, 7);
  assert.equal(readback.session.assessments[0].overall_score, null);
  assert.equal((await call(english, "english_list_practice_sessions", {skill: "listening"})).total, 1);
  assert.equal((await call(english, "english_get_summary", {})).summary.practice_sessions, 2);
  const progress = await call(english, "english_get_ielts_progress", {});
  assert.equal(progress.groups.length, 2);
  evidence.checks.push("five listening answer types", "no pre-answer leakage", "partial import rejected", "completed cumulative raw score", "single write path", "recovered-result replay", "changed source conflicts", "inconsistent raw totals rejected", "source lineage", "short practice has no invented band", "progress evidence");
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ok: true, ...evidence}));
} finally {
  for (const client of clients) await client.close();
  for (const server of servers) await server.close();
  child.stdin.end();
  await exited;
  lines.close();
}
