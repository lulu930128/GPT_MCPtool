import { createServer, createConnection, type Socket, type Server } from "node:net";
import { generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { ApprovalError, digest, parse, receiptSchema, resultSchema, type Receipt, type RunnerResult } from "./contract.js";
import { validateDelivery, type OfflineRunner } from "./runner.js";

// ISOLATED ONLY: cryptographic peer pins are not Windows token/ACL or out-of-job proof.
// No environment switch, MCP route, or host factory can promote this transport.
const CONTRACT = "normal-marker-isolated-ipc-v1";
const LIMIT = 16384;
const DEADLINE = 5500;
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const handoffSchema = z.object({
  requestId: uuid, receiptId: uuid, digest: hash, approvalEventId: uuid, bootId: uuid,
  jobId: uuid, turnId: z.string().min(1).max(128), executionMode: z.literal("NORMAL"),
  artifactId: z.literal("fixture.marker.v1"), executorId: z.literal("offline-normal-marker"),
  sid: z.string().regex(/^S-1-5-(?:\d+-)*\d+$/).max(184), expiresAt: z.number().int().nonnegative(),
}).strict();
export type Handoff = z.infer<typeof handoffSchema>;
const helloSchema = z.object({ contract: z.literal(CONTRACT), kind: z.literal("hello"),
  role: z.literal("operator"), session: uuid, serverNonce: uuid }).strict();
const dispatchSchema = z.object({ contract: z.literal(CONTRACT), kind: z.literal("dispatch"),
  role: z.literal("bridge"), session: uuid, serverNonce: uuid, clientNonce: uuid, handoff: handoffSchema }).strict();
const responseSchema = z.object({ contract: z.literal(CONTRACT), kind: z.literal("result"),
  role: z.literal("operator"), session: uuid, serverNonce: uuid, clientNonce: uuid,
  dispatchDigest: hash, result: resultSchema }).strict();
const signedSchema = z.object({ body: z.string().min(1).max(LIMIT), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type PeerKeys = { privateKey: KeyObject; publicKey: KeyObject };
export const isolatedPeerKeys = (): PeerKeys => generateKeyPairSync("ed25519");
const keyId = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("hex");
function distinctPeer(keys: PeerKeys, peer: KeyObject) {
  if (keys.privateKey.asymmetricKeyType !== "ed25519" || peer.asymmetricKeyType !== "ed25519"
    || keyId(keys.publicKey) === keyId(peer)) throw new ApprovalError("IPC_ROLE_REJECTED");
}
function seal(value: unknown, keys: PeerKeys): string {
  const body = JSON.stringify(value);
  const line = JSON.stringify({ body, signature: sign(null, Buffer.from(body), keys.privateKey).toString("base64") }) + "\n";
  if (Buffer.byteLength(line) > LIMIT) throw new ApprovalError("IPC_OUTPUT_LIMIT");
  return line;
}
function unseal<T>(line: string, peer: KeyObject, schema: z.ZodType<T>): T {
  try {
    const envelope = parse(signedSchema, JSON.parse(line));
    if (!verify(null, Buffer.from(envelope.body), peer, Buffer.from(envelope.signature, "base64"))) throw new Error();
    return parse(schema, JSON.parse(envelope.body));
  } catch { throw new ApprovalError("IPC_PEER_OR_FRAME_REJECTED"); }
}

/** One bounded stream, absolute deadline, no reconnect/retry or untrusted error text. */
function frames(socket: Socket) {
  let bytes = 0;
  let buffer = Buffer.alloc(0);
  let failure: ApprovalError | undefined;
  const queued: string[] = [];
  let waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  const fail = (code: string) => {
    if (failure) return;
    failure = new ApprovalError(code); waiter?.reject(failure); waiter = undefined;
    buffer.fill(0); buffer = Buffer.alloc(0); queued.length = 0; socket.destroy();
  };
  const timer = setTimeout(() => fail("IPC_TIMEOUT"), DEADLINE);
  socket.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > LIMIT) return fail("IPC_OUTPUT_LIMIT");
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
      if (waiter) { const current = waiter; waiter = undefined; current.resolve(line); }
      else queued.push(line);
      if (queued.length > 2) return fail("IPC_FRAME_REJECTED");
    }
  });
  socket.on("error", () => fail("IPC_DISCONNECTED"));
  socket.on("end", () => fail("IPC_DISCONNECTED"));
  socket.on("close", () => { clearTimeout(timer); fail("IPC_DISCONNECTED"); });
  return {
    read(): Promise<string> {
      if (failure) return Promise.reject(failure);
      if (queued.length) return Promise.resolve(queued.shift()!);
      if (waiter) return Promise.reject(new ApprovalError("IPC_CONCURRENT_READ"));
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    write(value: unknown, keys: PeerKeys) {
      if (failure) throw failure;
      socket.write(seal(value, keys));
    },
    close() { clearTimeout(timer); socket.destroy(); },
  };
}

export function handoffOf(value: Readonly<Receipt>): Handoff {
  const r = parse(receiptSchema, value);
  validateDelivery(r);
  return parse(handoffSchema, { requestId: r.request.requestId, receiptId: r.request.receiptId,
    digest: r.digest, approvalEventId: r.approvalEventId, bootId: r.request.bootId,
    jobId: r.request.jobId, turnId: r.request.turnId, executionMode: r.request.executionMode,
    artifactId: r.request.artifactId, executorId: r.request.executorId, sid: r.request.expectedSid,
    expiresAt: r.request.expiresAt });
}

/** Dispatch-scoped capability, armed ONLY by the canonical Broker's runner after journal fsync.
 * No approval database: the snapshot comes from Broker, never from the wire. A consumed capability
 * stays consumed even on timeout. On process restart Broker recovers RUNNING as UNKNOWN.
 * This in-process authority seam is deliberately isolated; a protected cross-process authority
 * and OS peer checks must be supplied before any host deployment can exist. */
export function createIsolatedHandoffAuthority() {
  const seen = new Set<string>();
  const active = new Map<string, { receipt: Receipt; handoff: Handoff }>();
  return Object.freeze({
    arm(value: Readonly<Receipt>) {
      const handoff = handoffOf(value);
      if (Date.now() >= handoff.expiresAt) throw new ApprovalError("TTL_EXPIRED");
      if (seen.has(handoff.requestId) || seen.size >= 100) throw new ApprovalError("IPC_REPLAY_OR_CAPACITY");
      seen.add(handoff.requestId);
      active.set(handoff.requestId, { receipt: structuredClone(value), handoff });
    },
    claim(value: unknown): Receipt {
      const h = parse(handoffSchema, value);
      const entry = active.get(h.requestId);
      if (!entry || digest(entry.handoff) !== digest(h)) throw new ApprovalError("IPC_GRANT_REJECTED");
      active.delete(h.requestId); // synchronous single use BEFORE any await or spawn
      if (Date.now() >= h.expiresAt) throw new ApprovalError("TTL_EXPIRED");
      return structuredClone(entry.receipt);
    },
    revoke(requestId: string) { active.delete(requestId); },
  });
}
export type HandoffAuthority = ReturnType<typeof createIsolatedHandoffAuthority>;

/** Called by the CC isolated owner only. No listener is opened on import. */
export async function listenIsolatedOperator(options: {
  keys: PeerKeys; bridgePublicKey: KeyObject; claim: HandoffAuthority["claim"]; runner: OfflineRunner;
}): Promise<{ port: number; session: string; close: () => Promise<void> }> {
  distinctPeer(options.keys, options.bridgePublicKey);
  const session = randomUUID();
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const serve = async (socket: Socket) => {
    const io = frames(socket);
    const serverNonce = randomUUID();
    try {
      io.write({ contract: CONTRACT, kind: "hello", role: "operator", session, serverNonce }, options.keys);
      const message = unseal(await io.read(), options.bridgePublicKey, dispatchSchema);
      if (message.session !== session || message.serverNonce !== serverNonce) throw new ApprovalError("IPC_NONCE_REJECTED");
      const receipt = options.claim(message.handoff);
      // No script/path/args/env from wire. Execution derives only from the canonical snapshot.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let raw: RunnerResult;
      try {
        raw = await Promise.race([options.runner(receipt), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ApprovalError("TIMEOUT")), 5200);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      const result = parse(resultSchema, raw);
      assertResult(result, message.handoff);
      io.write({ contract: CONTRACT, kind: "result", role: "operator", session, serverNonce,
        clientNonce: message.clientNonce, dispatchDigest: digest(message), result }, options.keys);
      socket.end();
    } catch { io.close(); } // no raw OS errors, paths, credentials or unverified result sent to Bridge
  };
  const server: Server = createServer(socket => {
    if (sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    const task = serve(socket); pending.add(task); void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  // A later listener error closes admission; no auto-restart.
  server.on("error", () => { server.close(); for (const socket of sockets) socket.destroy(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new ApprovalError("IPC_LISTENER_REJECTED");
  return { port: address.port, session, async close() {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed; await Promise.all(pending);
  } };
}
function assertResult(result: RunnerResult, h: Handoff) {
  if (result.requestId !== h.requestId || result.digest !== h.digest || result.sid !== h.sid
    || result.executorId !== h.executorId || result.executionMode !== h.executionMode) throw new ApprovalError("RESULT_REJECTED");
}
export async function exchangeIsolatedMarker(options: {
  port: number; session: string; keys: PeerKeys; operatorPublicKey: KeyObject; handoff: Handoff;
}): Promise<RunnerResult> {
  distinctPeer(options.keys, options.operatorPublicKey);
  const handoff = parse(handoffSchema, options.handoff);
  if (Date.now() >= handoff.expiresAt) throw new ApprovalError("TTL_EXPIRED");
  const socket = createConnection({ host: "127.0.0.1", port: options.port });
  const io = frames(socket);
  try {
    const hello = unseal(await io.read(), options.operatorPublicKey, helloSchema);
    if (hello.session !== options.session) throw new ApprovalError("IPC_SESSION_REJECTED");
    const message = { contract: CONTRACT, kind: "dispatch", role: "bridge", session: hello.session,
      serverNonce: hello.serverNonce, clientNonce: randomUUID(), handoff };
    io.write(message, options.keys);
    const response = unseal(await io.read(), options.operatorPublicKey, responseSchema);
    if (response.session !== hello.session || response.serverNonce !== hello.serverNonce
      || response.clientNonce !== message.clientNonce || response.dispatchDigest !== digest(message)) throw new ApprovalError("RESULT_REJECTED");
    assertResult(response.result, handoff);
    return response.result;
  } finally { io.close(); }
}
export function isolatedOperatorRunner(options: {
  authority: HandoffAuthority; port: number; session: string; keys: PeerKeys; operatorPublicKey: KeyObject;
}): OfflineRunner {
  return async receipt => {
    options.authority.arm(receipt);
    try { return await exchangeIsolatedMarker({ ...options, handoff: handoffOf(receipt) }); }
    finally { options.authority.revoke(receipt.request.requestId); }
  };
}

export function productionOperator(): never { throw new ApprovalError("BLOCKED_HOST_ACCEPTANCE"); }
