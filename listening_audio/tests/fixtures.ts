import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../src/config.js";
export const question = { ok: true, setId: "exam001", questionId: "Q001", position: 1, questionCount: 1,
  language: "ja", presentation: "text_options", options: [1, 2, 3, 4].map(key => ({ key, text: `Option ${key}` })),
  audio: { state: "missing", bytes: 0 } };
export const health = { ok: true, contractVersion: "listening-trainer-v1", languages: ["ja"],
  tts: { listenerRunning: false, readiness: "listener_only", profiles: [{ name: "male", listenerRunning: false }] } };
export const set = { schema_version: "1.2", set_id: "exam001", question_count: 1,
  questions: [{ id: "Q001", audio_script: [{ text: "明日の会議は午後三時からです。" }] }] };
export function wav() {
  const b = Buffer.alloc(76); b.write("RIFF"); b.writeUInt32LE(68, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(32, 40);
  return b;
}
export async function backend(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const a = server.address(); if (!a || typeof a === "string") throw Error("port");
  return { config: { ...loadConfig({}), trainerBaseUrl: `http://127.0.0.1:${a.port}` },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
export function send(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
}
