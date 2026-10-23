import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { types } from "node:util";

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000;

/** No OS-protected Host provider exists here. Nothing in this module grants approval. */
export const passwordVerifierAvailability = Object.freeze({
  productionEnabled: false,
  reason: "TRUSTED_HOST_PROVIDER_REQUIRED",
} as const);

export type PasswordVerifierRecord = Readonly<{
  version: 1;
  scope: "OFFLINE_ONLY";
  kdf: "scrypt";
  N: 16384;
  r: 8;
  p: 1;
  keyBytes: 32;
  saltHex: string;
  hashHex: string;
}>;
export type PasswordVerifier = ((candidate: Buffer) => Promise<boolean>) & { dispose(): void };

// Object identity establishes ONLY local/offline origin, never OS protection. Weak keys
// retain no credential database. A record may be bound once: no lockout reset by rebinding.
const issuedRecords = new WeakMap<PasswordVerifierRecord, boolean>();
const recordFields = ["version", "scope", "kdf", "N", "r", "p", "keyBytes", "saltHex", "hashHex"];

/** Schema validation alone confers no provenance and cannot enable a verifier. */
export function isPasswordVerifierRecord(value: unknown): value is PasswordVerifierRecord {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== recordFields.length || keys.some(key => typeof key !== "string" || !recordFields.includes(key))) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (recordFields.some(key => !("value" in fields[key]) || !fields[key].enumerable)) return false;
    const get = (key: string): unknown => fields[key].value;
    const hex = (field: unknown) => typeof field === "string" && field.length === 64 && /^[a-f0-9]{64}$/.test(field);
    return get("version") === 1 && get("scope") === "OFFLINE_ONLY" && get("kdf") === "scrypt"
      && get("N") === SCRYPT.N && get("r") === SCRYPT.r && get("p") === SCRYPT.p && get("keyBytes") === KEY_BYTES
      && hex(get("saltHex")) && hex(get("hashHex"));
  } catch { return false; }
}

function wipe(value: unknown): void {
  if (Buffer.isBuffer(value)) value.fill(0);
}

// Never decode the password into an immutable JS string. Count UTF-8 scalar values,
// not bytes or UTF-16 units. No normalization/trimming and no silent replacement.
function consume(input: Buffer): Buffer {
  let copy: Buffer | undefined;
  try {
    if (!Buffer.isBuffer(input) || types.isSharedArrayBuffer(input.buffer)
      || input.length < 16 || input.length > 256) throw new Error("VERIFIER_INPUT_REJECTED");
    copy = Buffer.from(input);
    if (!isUtf8(copy)) throw new Error("VERIFIER_INPUT_REJECTED");
    let characters = 0;
    for (const byte of copy) characters += (byte & 0xc0) !== 0x80 ? 1 : 0;
    if (characters < 16) throw new Error("VERIFIER_INPUT_REJECTED");
    return copy;
  } catch {
    copy?.fill(0);
    throw new Error("VERIFIER_INPUT_REJECTED");
  } finally { wipe(input); }
}

function derive(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(secret, salt, KEY_BYTES, SCRYPT,
    (error, key) => {
      if (error) { key?.fill(0); reject(new Error("VERIFIER_UNAVAILABLE")); }
      else resolve(key);
    }));
}

/** Creates a versioned in-memory OFFLINE record; performs no real enrollment/storage IO.
 * The returned hash is sensitive verifier material. Do not log or publish it. */
export async function createPasswordVerifierRecord(enrollment: Buffer): Promise<PasswordVerifierRecord> {
  let secret: Buffer | undefined;
  let salt: Buffer | undefined;
  let expected: Buffer | undefined;
  try {
    secret = consume(enrollment);
    salt = randomBytes(SALT_BYTES);
    expected = await derive(secret, salt);
    const record: PasswordVerifierRecord = Object.freeze({ version: 1, scope: "OFFLINE_ONLY", kdf: "scrypt",
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyBytes: KEY_BYTES,
      saltHex: salt.toString("hex"), hashHex: expected.toString("hex") });
    if (!isPasswordVerifierRecord(record)) throw new Error("VERIFIER_UNAVAILABLE");
    issuedRecords.set(record, false);
    return record;
  } catch (error) {
    throw new Error(!secret && error instanceof Error && error.message === "VERIFIER_INPUT_REJECTED"
      ? "VERIFIER_INPUT_REJECTED" : "VERIFIER_UNAVAILABLE");
  } finally { wipe(enrollment); secret?.fill(0); salt?.fill(0); expected?.fill(0); }
}

// Fixed-width, fixed-iteration unsigned comparison with no data-dependent early exit.
// Times are public. JS/JIT scheduling is NOT a cryptographic constant-time guarantee.
function timeLessThan(left: number, right: number): boolean {
  const a = Buffer.alloc(8);
  const b = Buffer.alloc(8);
  a.writeUInt32BE(Math.floor(left / 0x100000000), 0);
  a.writeUInt32BE(left >>> 0, 4);
  b.writeUInt32BE(Math.floor(right / 0x100000000), 0);
  b.writeUInt32BE(right >>> 0, 4);
  let less = 0;
  let greater = 0;
  for (let i = 0; i < 8; i++) {
    const undecided = 1 ^ (less | greater);
    less |= ((a[i] - b[i]) >>> 31) & undecided;
    greater |= ((b[i] - a[i]) >>> 31) & undecided;
  }
  return less === 1;
}

/** Only accepts the exact frozen record issued in this process, once. Serialized records,
 * checkout/env/MCP input, caller-provided providers and protected=true are NOT trusted.
 * Clock injection is OFFLINE test support, never proof of a trusted Host clock. */
export function offlinePasswordVerifierFromRecord(record: unknown, clock: () => number = Date.now): PasswordVerifier {
  if (!isPasswordVerifierRecord(record) || !issuedRecords.has(record) || !Object.isFrozen(record)) {
    throw new Error("VERIFIER_RECORD_SOURCE_REJECTED");
  }
  if (issuedRecords.get(record)) throw new Error("VERIFIER_RECORD_ALREADY_BOUND");
  issuedRecords.set(record, true);
  const salt = Buffer.from(record.saltHex, "hex");
  const expected = Buffer.from(record.hashHex, "hex");
  let failures = 0;
  let lockedUntil = 0;
  let lastTime = 0;
  let stopped = false;
  let busy = false;
  const dispose = () => { stopped = true; salt.fill(0); expected.fill(0); };
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - LOCKOUT_MS
      || timeLessThan(value, lastTime)) throw new Error("VERIFIER_UNAVAILABLE");
    lastTime = value;
    return value;
  };
  try { now(); } catch { dispose(); throw new Error("VERIFIER_UNAVAILABLE"); }
  const failed = (time: number) => {
    failures = Math.min(MAX_ATTEMPTS, failures + 1);
    if (failures === MAX_ATTEMPTS) lockedUntil = time + LOCKOUT_MS;
    return false;
  };
  const verify = async (candidate: Buffer): Promise<boolean> => {
    let secret: Buffer | undefined;
    let actual: Buffer | undefined;
    let ownsAttempt = false;
    try {
      if (stopped) return false;
      const startedAt = now();
      // Reject concurrent calls without queuing passwords or allocating more KDF work.
      if (busy || timeLessThan(startedAt, lockedUntil)) return false;
      if (lockedUntil !== 0) { failures = 0; lockedUntil = 0; }
      busy = true;
      ownsAttempt = true;
      try { secret = consume(candidate); } catch { return failed(startedAt); }
      actual = await derive(secret, salt);
      const completedAt = now(); // Rollback during KDF cannot produce success.
      if (stopped) return false;
      const matches = timingSafeEqual(actual, expected);
      if (!matches) return failed(completedAt);
      failures = 0;
      return true;
    } catch {
      dispose(); // Clock/KDF errors latch closed; later good inputs cannot recover it.
      return false;
    } finally {
      wipe(candidate); secret?.fill(0); actual?.fill(0);
      if (ownsAttempt) busy = false;
    }
  };
  return Object.assign(verify, { dispose });
}

/** Legacy callable API, still OFFLINE only; consumes every supplied Buffer. */
export async function offlinePasswordVerifier(enrollment: Buffer): Promise<PasswordVerifier> {
  return offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(enrollment));
}
