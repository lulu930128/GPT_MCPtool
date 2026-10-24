import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { DOWNLOAD_UI_URI, downloadHtml } from "./download-app.js";
import type { Config } from "./config.js";
import { ListeningError, errorResult } from "./errors.js";
import { createInput, questionInput, answerInput, setId, id } from "./schemas.js";
import { TrainerClient } from "./trainer-client.js";
export const VERSION = "0.2.0";
export const CONTRACT = "listening-audio-v2";
export const TOOL_COUNT = 7;
export function audioUri(s: string, q: string) { return `listening-audio://sets/${s}/${q}.wav`; }
export function createMcpServer(config: Config, client = new TrainerClient(config)) {
  const server = new McpServer({ name: "listening-audio", version: VERSION });
  registerAppResource(server, "question-download-ui", DOWNLOAD_UI_URI, {}, async () => ({
    contents: [{ uri: DOWNLOAD_UI_URI, mimeType: RESOURCE_MIME_TYPE, text: downloadHtml(),
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "A button to test host-mediated download of an existing question WAV. No playback or synthesis.",
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] } } }]
  }));
  const register = <T extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<T>,
    readonly: boolean, run: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readonly, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      try {
        const result = await run(schema.parse(args));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      } catch (error) {
        const result = errorResult(error instanceof z.ZodError ? new ListeningError("INVALID_REQUEST") : error);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  };
  register("listening_health", "Read Trainer contract and TTS listener status without starting services. Listener status is not synthesis proof.",
    z.object({}).strict(), true, async () => ({ ...await client.health(), mcp: { version: VERSION, contractVersion: CONTRACT, toolCount: TOOL_COUNT } }));
  register("listening_create_exam", "Store an immutable Japanese schema 1.2 or English IELTS practice schema 2.0 exam. Same set ID and content can be retried; changed content conflicts. Does not generate audio. Never display the submitted answer key or script before the learner answers. English schema 2.0 requires scope, source_ref, typed expected_answers, prompt, section and audio_script; generated sets are not calibrated IELTS papers.",
    createInput(config), false, async input => {
      if ((input.language === "ja" && input.set.schema_version !== "1.2") || (input.language === "en" && input.set.schema_version !== "2.0") || (input.language === "ja" && input.set.question_count > 20)) throw new ListeningError("INVALID_SET");
      const result = await client.create(input);
      if (result.setId !== input.set.set_id) throw new ListeningError("TRAINER_INVALID_RESPONSE");
      return result;
    });
  const projectedQuestion = async (s: string, q: string, prepare: boolean) => {
    const result = prepare ? await client.prepare(s, q) : await client.question(s, q);
    if (result.setId !== s || result.questionId !== q) throw new ListeningError("TRAINER_INVALID_RESPONSE");
    return { ...result, audio: { ...result.audio, ...(result.audio.state === "ready" ? { resourceUri: audioUri(s, q), mimeType: "audio/wav" } : {}) } };
  };
  register("listening_get_question", "Read safe question options and current audio availability. Never generates audio or returns answer keys, translations, or scripts.",
    questionInput, true, input => projectedQuestion(input.setId, input.questionId, false));
  registerAppTool(server, "listening_render_question", {
    description: "Use this when the learner wants a download button for an existing question WAV. First use listening_get_question and, only if needed and requested, listening_prepare_audio. Read-only: never generates audio. The widget tests host download support; do not claim the file was saved until the learner verifies it.",
    inputSchema: questionInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: DOWNLOAD_UI_URI }, "openai/outputTemplate": DOWNLOAD_UI_URI }
  }, async args => {
    try {
      const input = questionInput.parse(args);
      const value = await projectedQuestion(input.setId, input.questionId, false);
      const result = { ok: true, setId: value.setId, questionId: value.questionId,
        audio: { ...value.audio, ...(value.audio.state === "ready" ? { filename: `${value.questionId}.wav` } : {}) } };
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const result = errorResult(error instanceof z.ZodError ? new ListeningError("INVALID_REQUEST") : error);
      return { isError: true, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  });
  register("listening_prepare_audio", "Generate or reuse one question's audio via Trainer; may start existing configured TTS profiles. Can take several minutes. On TIMEOUT poll listening_get_question; on BUSY wait before retrying. No force regeneration.",
    questionInput, false, input => projectedQuestion(input.setId, input.questionId, true));
  register("listening_submit_answer", "Submit actual learner answers: Japanese integers 1..4; English {type,value} or null for blank. Reuse attemptId/submissionId on retries. English finalize=true completes the attempt and marks omitted answers blank; only finalize when the learner has finished. English responses are cumulative; Japanese scores remain per submission. Does not itself update Study records.",
    answerInput, false, input => client.answer(input));
  register("listening_get_attempt_result", "Read a recoverable cumulative English attempt. In-progress results expose only submitted answers. Completed listening-result-v2 can be passed unchanged as listeningResult to English Study preview/record, after saving is authorized. Never treat a partial attempt as completed or invent a band.",
    z.object({setId, attemptId: id}).strict(), true, input => client.result(input.setId, input.attemptId));
  server.registerResource("question-audio", new ResourceTemplate("listening-audio://sets/{setId}/{questionId}.wav", { list: undefined }),
    { mimeType: "audio/wav", description: "Existing question WAV, maximum 12 MiB. Read-only; never starts TTS." },
    async (uri) => {
      try {
        const match = /^listening-audio:\/\/sets\/([A-Za-z0-9][A-Za-z0-9_.-]{2,80})\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.wav$/.exec(uri.href);
        if (!match) throw new ListeningError("INVALID_QUESTION");
        const body = await client.audio(setId.parse(match[1]), id.parse(match[2]));
        return { contents: [{ uri: uri.href, mimeType: "audio/wav", blob: body.toString("base64") }] };
      } catch (e) { throw new McpError(ErrorCode.InvalidRequest, errorResult(e).error.code); }
    });
  return server;
}
