import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalError, parse, productionRequestSchema, hostPeerEvidenceSchema, normalExecutionObservationSchema } from "./contract.js";
import { reviewBindingSchema } from "./review-contract.js";
import type { PowerShellHostPort } from "./host-admission.js";
import { observedNativeChannel } from "./host-transport.js";
import { normalOutputSchema, normalOutputChunkSchema } from "./normal-output.js";

export const HOST_RPC = "powershell-host-rpc-v1";
export const HOST_FRAME_BYTES = 131028;
const binding = reviewBindingSchema;
const initialBase = z.object({ contract: z.literal(HOST_RPC), session: z.string().uuid(), expiresAt: z.number().safe().int() });
export const hostInitialSchema = z.discriminatedUnion("operation", [
  initialBase.extend({ operation: z.literal("preflight") }).strict(),
  initialBase.extend({ operation: z.literal("review"), review: binding }).strict(),
]);
const operations = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), payload: binding }).strict(),
  z.object({ operation: z.literal("admit"), payload: productionRequestSchema }).strict(),
  z.object({ operation: z.literal("decide"), payload: binding.extend({ decision: z.enum(["APPROVED", "DENIED"]), observation: hostPeerEvidenceSchema }).strict() }).strict(),
  z.object({ operation: z.literal("claim"), payload: binding.extend({ observation: hostPeerEvidenceSchema }).strict() }).strict(),
  z.object({ operation: z.literal("output"), payload: binding.extend({ stream: z.enum(["stdout", "stderr"]),
    offset: z.number().int().nonnegative(), dataBase64: normalOutputChunkSchema }).strict() }).strict(),
  z.object({ operation: z.literal("ingestNormal"), payload: z.object({ observation: normalExecutionObservationSchema, executor: hostPeerEvidenceSchema, output: normalOutputSchema.optional() }).strict() }).strict(),
  z.object({ operation: z.literal("receipt"), payload: binding }).strict(),
  z.object({ operation: z.literal("deliveryUncertain"), payload: binding }).strict(),
]);
const frameSchema = z.object({ contract: z.literal(HOST_RPC), session: z.string().uuid(),
  channelBinding: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().min(1).max(2147483647),
  expiresAt: z.number().safe().int(), message: operations }).strict();

/** One exchange owned by the runtime's retained native helper. The session nonce
 * correlates stdio; it is NOT an authorization token. Store's mandatory verifier
 * receives no caller data as authority and remains sealed. No verifier injection. */
export function createHostReceiver(port: PowerShellHostPort, reviewBinding: z.infer<typeof binding>) {
  const review = parse(binding, reviewBinding), session = randomUUID(), created = Date.now(), expiresAt = created + 120_000;
  let next = 1, busy = false, closed = false;
  let phase: "new" | "prepared" | "admitted" | "approved" | "consumed" | "done" = "new";
  let production: z.infer<typeof binding> | undefined;
  let lowering: Promise<void> | undefined;
  const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const exact = (a: z.infer<typeof binding>, b: z.infer<typeof binding>) => {
    if (a.requestId !== b.requestId || a.digest !== b.digest) throw new ApprovalError("HOST_REQUEST_MISMATCH");
  };
  const lower = async () => {
    if (phase === "consumed" && production) {
      lowering ??= port.deliveryUncertain(production.requestId);
      await lowering; phase = "done";
    }
  };
  const requirePhase = (value: typeof phase) => {
    if (phase !== value) throw new ApprovalError("INVALID_TRANSITION");
  };
  return Object.freeze({ session, expiresAt, review,
    async receive(bytes: Uint8Array, nativeChannel?: unknown) {
      if (closed || busy) throw new ApprovalError("HOST_SESSION_CLOSED_OR_BUSY");
      // A JSON hash is never adopted as proof. Only the runtime-owned retained
      // helper can mint this in-memory transport correlation object. It still
      // does not by itself authorize a transition without the exact DIRECT binding.
      const channel = observedNativeChannel(nativeChannel, session);
      if (bytes.byteLength < 1 || bytes.byteLength > HOST_FRAME_BYTES) throw new ApprovalError("IPC_FRAME_REJECTED");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new ApprovalError("IPC_FRAME_REJECTED"); }
      const frame = parse(frameSchema, raw);
      const now = Date.now();
      if (frame.session !== session || frame.sequence !== next || channel !== frame.channelBinding)
        throw new ApprovalError("IPC_REPLAY_OR_BINDING_REJECTED");
      if (now < created || now >= expiresAt || frame.expiresAt !== expiresAt) throw new ApprovalError("TTL_EXPIRED");
      // Reserve before awaiting canonical IO, including on refusal. No replay cache
      // can turn a second claim into a second delivery.
      next++; busy = true;
      try {
        const m = frame.message;
        let result: unknown;
        switch (m.operation) {
          case "prepare":
            requirePhase("new"); exact(m.payload, review);
            result = await port.snapshot(review.requestId, review.digest); phase = "prepared"; break;
          case "admit": {
            requirePhase("prepared");
            if (!m.payload.sourceReview) throw new ApprovalError("SOURCE_REVIEW_REQUIRED");
            exact(m.payload.sourceReview, review);
            if (m.payload.executionMode !== "NORMAL") throw new ApprovalError("BLOCKED_AWAITING_LOCAL_UAC");
            const saved = await port.admit(review.requestId, review.digest, m.payload, nativeChannel);
            production = { requestId: saved.request.requestId, digest: saved.digest };
            phase = "admitted"; result = saved; break;
          }
          case "decide": {
            requirePhase("admitted"); exact(m.payload, production!);
            result = await port.decide(m.payload.requestId, m.payload.digest, m.payload.decision, m.payload.observation, nativeChannel);
            phase = m.payload.decision === "APPROVED" ? "approved" : "done"; break;
          }
          case "claim":
            requirePhase("approved"); exact(m.payload, production!);
            // Store serial queue fsyncs CONSUMED before this await can produce bytes.
            result = await port.claim(m.payload.requestId, m.payload.digest, m.payload.observation, nativeChannel);
            phase = "consumed"; break;
          case "output": {
            requirePhase("consumed"); exact(m.payload, production!);
            const part = Buffer.from(m.payload.dataBase64, "base64"), stream = m.payload.stream;
            if (m.payload.offset !== sizes[stream] || part.toString("base64") !== m.payload.dataBase64)
              throw new ApprovalError("NORMAL_OUTPUT_REJECTED");
            output[stream].push(part); sizes[stream] += part.length;
            result = { receivedBytes: sizes[stream] }; break;
          }
          case "ingestNormal": {
            requirePhase("consumed"); exact(m.payload.observation, production!);
            if (m.payload.output && (sizes.stdout || sizes.stderr)) throw new ApprovalError("NORMAL_OUTPUT_REJECTED");
            const captured = m.payload.output ?? { stdoutBase64: Buffer.concat(output.stdout).toString("base64"),
              stderrBase64: Buffer.concat(output.stderr).toString("base64") };
            if (Buffer.from(captured.stdoutBase64, "base64").length !== m.payload.observation.stdoutBytes
              || Buffer.from(captured.stderrBase64, "base64").length !== m.payload.observation.stderrBytes)
              throw new ApprovalError("NORMAL_OUTPUT_REJECTED");
            await port.ingestNormal(m.payload.observation, m.payload.executor, nativeChannel, captured);
            output.stdout.length = output.stderr.length = 0;
            phase = "done"; result = await port.receipt(review.requestId); break;
          }
          case "deliveryUncertain":
            requirePhase("consumed"); exact(m.payload, production!); await lower();
            result = await port.receipt(review.requestId); break;
          case "receipt":
            exact(m.payload, review); result = await port.receipt(review.requestId); break;
        }
        if (closed || Date.now() >= expiresAt || Date.now() < created) {
          await lower(); throw new ApprovalError("HOST_DELIVERY_UNCERTAIN");
        }
        return { contract: HOST_RPC, session, sequence: frame.sequence, result };
      } finally { busy = false; if (closed) await lower(); }
    },
    async close() { closed = true; await lower(); output.stdout.length = output.stderr.length = 0; },
  });
}
export type HostReceiver = ReturnType<typeof createHostReceiver>;
