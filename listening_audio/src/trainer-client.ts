import type { z } from "zod";
import type { Config } from "./config.js";
import { ListeningError } from "./errors.js";
import { answerResult, examResult, healthResult, safeQuestion, setId, id } from "./schemas.js";
export const PREFIX = "/api/listening/v1";
const codes = new Set(["INVALID_SET", "INVALID_QUESTION", "INVALID_ANSWER", "INVALID_REQUEST", "SET_CONFLICT", "SUBMISSION_CONFLICT",
  "ANSWER_CONFLICT", "EXAM_NOT_FOUND", "AUDIO_NOT_FOUND", "AUDIO_STALE", "AUDIO_INVALID", "AUDIO_TOO_LARGE", "TTS_NOT_READY",
  "TTS_GENERATION_FAILED", "BUSY", "STORAGE_ERROR", "METHOD_NOT_ALLOWED"]);
export class TrainerClient {
  constructor(readonly config: Config) {}
  async request(path: string, method = "GET", body?: unknown, audio = false, timeout = 10000): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this.config.trainerBaseUrl + PREFIX + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
        redirect: "error", headers: { accept: audio ? "audio/wav" : "application/json", "content-type": "application/json" }
      });
      const limit = audio && response.ok ? 12 * 1024 * 1024 : 524288;
      if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new ListeningError("RESPONSE_TOO_LARGE"); }
      const reader = response.body?.getReader();
      if (!reader) throw new ListeningError("TRAINER_INVALID_RESPONSE");
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length;
        if (bytes > limit) { await reader.cancel(); throw new ListeningError("RESPONSE_TOO_LARGE"); }
        chunks.push(next.value);
      }
      const data = Buffer.concat(chunks);
      if (!response.ok) {
        let code = "TRAINER_HTTP_ERROR";
        try { const candidate = JSON.parse(data.toString("utf8"))?.error?.code; if (codes.has(candidate)) code = candidate; } catch { /* Never expose upstream error text. */ }
        throw new ListeningError(code, response.status === 503 || response.status === 429, response.status);
      }
      const mime = response.headers.get("content-type")?.split(";")[0].trim();
      if (audio) {
        if (mime !== "audio/wav") throw new ListeningError("AUDIO_INVALID");
        validateWav(data); return data;
      }
      if (mime !== "application/json") throw new ListeningError("TRAINER_INVALID_RESPONSE");
      try { return JSON.parse(data.toString("utf8")); } catch { throw new ListeningError("TRAINER_INVALID_RESPONSE"); }
    } catch (e) {
      if (e instanceof ListeningError) throw e;
      throw new ListeningError(controller.signal.aborted ? "TIMEOUT" : "TRAINER_UNREACHABLE", true);
    } finally { clearTimeout(timer); }
  }
  private parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) throw new ListeningError("TRAINER_INVALID_RESPONSE");
    return result.data;
  }
  async health() { return this.parse(healthResult, await this.request("/health", "GET", undefined, false, 5000)); }
  async create(input: unknown) { return this.parse(examResult, await this.request("/exams", "POST", input)); }
  path(s: string, q?: string) {
    setId.parse(s); if (q !== undefined) id.parse(q);
    return `/exams/${encodeURIComponent(s)}${q === undefined ? "" : `/questions/${encodeURIComponent(q)}`}`;
  }
  async question(s: string, q: string) { return this.parse(safeQuestion, await this.request(this.path(s, q))); }
  async prepare(s: string, q: string) {
    return this.parse(safeQuestion, await this.request(this.path(s, q) + "/audio", "POST", {}, false, this.config.timeoutMs));
  }
  async answer(input: { setId: string; attemptId: string; submissionId: string; answers: Record<string, number> }) {
    const { setId: s, ...body } = input;
    const result = this.parse(answerResult, await this.request(this.path(s) + "/answers", "POST", body));
    if (result.setId !== s || result.attemptId !== input.attemptId || result.submissionId !== input.submissionId ||
      result.details.length !== Object.keys(input.answers).length || new Set(result.details.map(d => d.questionId)).size !== result.details.length ||
      result.details.some(d => input.answers[d.questionId] !== d.chosen)) throw new ListeningError("TRAINER_INVALID_RESPONSE");
    return result;
  }
  async audio(s: string, q: string): Promise<Buffer> {
    return await this.request(this.path(s, q) + "/audio", "GET", undefined, true, 10000) as Buffer;
  }
}
export function validateWav(data: Buffer): void {
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE" ||
    data.readUInt32LE(4) + 8 !== data.length) throw new ListeningError("AUDIO_INVALID");
  let fmt = false, samples = false;
  for (let pos = 12; pos + 8 <= data.length;) {
    const size = data.readUInt32LE(pos + 4), end = pos + 8 + size;
    if (end > data.length) throw new ListeningError("AUDIO_INVALID");
    const tag = data.toString("ascii", pos, pos + 4);
    if (tag === "fmt ") {
      if (size < 16 || data.readUInt16LE(pos + 8) !== 1 || data.readUInt16LE(pos + 10) < 1 || data.readUInt32LE(pos + 12) < 1) throw new ListeningError("AUDIO_INVALID");
      fmt = true;
    }
    if (tag === "data" && size > 0) samples = true;
    pos = end + (size % 2);
  }
  if (!fmt || !samples) throw new ListeningError("AUDIO_INVALID");
}
