import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { ListeningError, errorResult } from "./errors.js";
import { createInput, questionInput, answerInput, setId, id } from "./schemas.js";
import { TrainerClient } from "./trainer-client.js";
export const VERSION = "0.1.0";
export const CONTRACT = "listening-audio-v1";
export const TOOL_COUNT = 5;
export function audioUri(s: string, q: string) { return `listening-audio://sets/${s}/${q}.wav`; }
export function createMcpServer(config: Config, client = new TrainerClient(config)) {
  const server = new McpServer({ name: "listening-audio", version: VERSION });
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
  register("listening_create_exam", "Store an immutable Japanese schema 1.2 exam. Same set ID and content can be retried; changed content conflicts. Does not generate audio. Use text_options for printed Japanese options, audio_only only when options are included in the audio script. Never display the submitted answer key or script before the learner answers.",
    createInput(config), false, async input => {
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
  register("listening_prepare_audio", "Generate or reuse one question's audio via Trainer; may start existing configured TTS profiles. Can take several minutes. On TIMEOUT poll listening_get_question; on BUSY wait before retrying. No force regeneration.",
    questionInput, false, input => projectedQuestion(input.setId, input.questionId, true));
  register("listening_submit_answer", "Submit actual learner choices. Reuse attemptId for this practice and submissionId on retries. Submitted choices are immutable within an attempt. Only submitted questions return explanations. A new attemptId starts a retake; this does not update Japanese/English Study learning records.",
    answerInput, false, input => client.answer(input));
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
