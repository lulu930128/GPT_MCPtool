import assert from "node:assert/strict";
import crypto, { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createPasswordVerifierRecord, isPasswordVerifierRecord, offlinePasswordVerifier,
  offlinePasswordVerifierFromRecord, passwordVerifierAvailability } from "../src/powershell-approval/password.js";

// Ephemeral synthetic inputs only; no stored password, filesystem, Host or broker.
const password = (length = 32) => {
  const input = randomBytes(length);
  for (let i = 0; i < input.length; i++) input[i] = 33 + input[i] % 94;
  return input;
};
const erased = (input: Buffer) => assert.equal(input.every(byte => byte === 0), true);

test("versioned record has fixed scrypt parameters, random salts and independent KDF parity", async () => {
  const secret = password();
  try {
    const enrollment = Buffer.from(secret);
    const pending = createPasswordVerifierRecord(enrollment);
    erased(enrollment); // Input ownership transfers synchronously, before KDF completion.
    const first = await pending;
    const second = await createPasswordVerifierRecord(Buffer.from(secret));
    assert.equal(isPasswordVerifierRecord(first), true);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(first.version, 1);
    assert.equal(first.scope, "OFFLINE_ONLY");
    assert.equal(first.N, 16384);
    assert.equal(first.r, 8);
    assert.equal(first.p, 1);
    assert.equal(first.keyBytes, 32);
    assert.equal(first.saltHex.length, 64);
    assert.equal(first.hashHex.length, 64);
    assert.equal(first.saltHex === second.saltHex, false);
    assert.equal(first.hashHex === second.hashHex, false);
    const expected = scryptSync(secret, Buffer.from(first.saltHex, "hex"), 32,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
    const hash = Buffer.from(first.hashHex, "hex");
    try { assert.equal(timingSafeEqual(expected, hash), true); }
    finally { expected.fill(0); hash.fill(0); }
  } finally { secret.fill(0); }
});

test("strict schema rejects unsupported versions/parameters, extras, accessors and malformed encodings", async () => {
  const record = await createPasswordVerifierRecord(password());
  const changes = [{ version: 2 }, { scope: "PRODUCTION" }, { kdf: "pbkdf2" }, { N: 32768 }, { r: 1 },
    { p: 2 }, { keyBytes: 64 }, { saltHex: "0".repeat(62) }, { saltHex: "A".repeat(64) },
    { hashHex: "g".repeat(64) }, { hashHex: "0".repeat(66) }, { hashHex: "0".repeat(64) + "\n" },
    { protected: true }, { maxmem: 1 }, { N: "16384" }];
  for (const patch of changes) assert.equal(isPasswordVerifierRecord({ ...record, ...patch }), false);
  const missing: { -readonly [K in keyof typeof record]?: (typeof record)[K] } = { ...record };
  delete missing.hashHex;
  let getterCalls = 0;
  const accessor = { ...record };
  Object.defineProperty(accessor, "hashHex", { enumerable: true, get() { getterCalls++; return record.hashHex; } });
  const hidden = { ...record };
  Object.defineProperty(hidden, "hashHex", { enumerable: false });
  for (const invalid of [null, [], JSON.stringify(record), missing, accessor, hidden,
    Object.assign(Object.create(record), {}), { ...record, [Symbol("source")]: true }, new Proxy(record, {})]) {
    assert.equal(isPasswordVerifierRecord(invalid), false);
  }
  assert.equal(getterCalls, 0);
});

test("source identity cannot be asserted by JSON, object copies or protected=true; binding is single-use", async () => {
  const record = await createPasswordVerifierRecord(password());
  const parsed: unknown = JSON.parse(JSON.stringify(record));
  assert.equal(isPasswordVerifierRecord(parsed), true); // Format is not authority.
  for (const untrusted of [parsed, { ...record }, Object.freeze({ ...record }), new Proxy(record, {}),
    { ...record, protected: true }, { record, protected: true }, { read: () => record, protected: true }]) {
    assert.throws(() => offlinePasswordVerifierFromRecord(untrusted), /^Error: VERIFIER_RECORD_SOURCE_REJECTED$/);
  }
  const verify = offlinePasswordVerifierFromRecord(record);
  assert.throws(() => offlinePasswordVerifierFromRecord(record), /^Error: VERIFIER_RECORD_ALREADY_BOUND$/);
  verify.dispose();
  assert.throws(() => offlinePasswordVerifierFromRecord(record), /^Error: VERIFIER_RECORD_ALREADY_BOUND$/);
  assert.deepEqual(passwordVerifierAvailability, { productionEnabled: false, reason: "TRUSTED_HOST_PROVIDER_REQUIRED" });
  assert.equal(Object.isFrozen(passwordVerifierAvailability), true);
});

test("legacy callable contract consumes success/wrong inputs and disposes permanently", async () => {
  const secret = password();
  const verify = await offlinePasswordVerifier(Buffer.from(secret));
  try {
    const wrong = Buffer.from(secret); wrong[0] ^= 1;
    assert.equal(await verify(wrong), false); erased(wrong);
    const candidate = Buffer.from(secret);
    const pending = verify(candidate);
    erased(candidate);
    candidate.fill(1); // Caller mutation cannot change the already captured KDF input.
    assert.equal(await pending, true); erased(candidate);
    verify.dispose();
    const after = Buffer.from(secret);
    assert.equal(await verify(after), false); erased(after);
  } finally { secret.fill(0); verify.dispose(); }
});

test("16 Unicode scalars minimum, 256 UTF-8 bytes maximum; malformed UTF-8 rejected and erased", async () => {
  for (const invalid of [Buffer.alloc(0), password(15), password(257), Buffer.from("界".repeat(15)),
    Buffer.from("😀".repeat(15)), Buffer.alloc(32, 0xff), Buffer.from([0xc0, 0xaf, ...password(16)]),
    Buffer.from(new SharedArrayBuffer(32))]) {
    await assert.rejects(createPasswordVerifierRecord(invalid), /^Error: VERIFIER_INPUT_REJECTED$/);
    erased(invalid);
  }
  for (const valid of [password(16), password(256), Buffer.from("界".repeat(16)), Buffer.from("😀".repeat(64))]) {
    const verify = await offlinePasswordVerifier(Buffer.from(valid));
    try { assert.equal(await verify(valid), true); erased(valid); }
    finally { verify.dispose(); valid.fill(0); }
  }
});

test("three failures lock out; invalid candidates count; lockout boundary is exact and bounded", async () => {
  let time = 0xfffffff0; // Exercise the high/low 32-bit time boundary.
  const secret = password();
  const verify = offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(Buffer.from(secret)), () => time);
  try {
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(32, 0xff), password(257)]) {
      assert.equal(await verify(invalid), false); erased(invalid);
    }
    for (let i = 0; i < 12; i++) {
      const candidate = Buffer.from(secret);
      assert.equal(await verify(candidate), false); erased(candidate);
    }
    time += 29_999;
    assert.equal(await verify(Buffer.from(secret)), false);
    time++;
    assert.equal(await verify(Buffer.from(secret)), true);
    // A successful check resets consecutive failures, but locked calls never reset/extend expiry.
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 2; i++) {
        const wrong = Buffer.from(secret); wrong[0] ^= 1;
        assert.equal(await verify(wrong), false); erased(wrong);
      }
      assert.equal(await verify(Buffer.from(secret)), true);
    }
  } finally { secret.fill(0); verify.dispose(); }
});

test("concurrent checks are rejected without queuing or resetting the failure budget", async () => {
  const secret = password();
  let time = 1000;
  const verify = offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(Buffer.from(secret)), () => time);
  try {
    for (let i = 0; i < 3; i++) {
      const wrong = Buffer.from(secret); wrong[0] ^= 1;
      const pending = verify(wrong);
      const parallel = Buffer.from(secret);
      assert.equal(await verify(parallel), false); erased(parallel);
      assert.equal(await pending, false); erased(wrong);
    }
    assert.equal(await verify(Buffer.from(secret)), false);
    time += 30_000;
    assert.equal(await verify(Buffer.from(secret)), true);
  } finally { secret.fill(0); verify.dispose(); }
});

test("clock rollback before/during KDF or while locked latches closed even after time recovers", async () => {
  const secret = password();
  try {
    for (const phase of ["before", "during", "locked"] as const) {
      let time = 0x100000000;
      const verify = offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(Buffer.from(secret)), () => time);
      try {
        if (phase === "locked") for (let i = 0; i < 3; i++) await verify(Buffer.alloc(0));
        const candidate = Buffer.from(secret);
        if (phase !== "during") time--;
        const pending = verify(candidate);
        if (phase === "during") time--;
        assert.equal(await pending, false); erased(candidate);
        time += 100_000;
        assert.equal(await verify(Buffer.from(secret)), false);
      } finally { verify.dispose(); }
    }
  } finally { secret.fill(0); }
});

test("invalid/throwing clocks and deadline overflow fail closed without leaking raw errors", async () => {
  for (const time of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER - 29_999]) {
    const record = await createPasswordVerifierRecord(password());
    assert.throws(() => offlinePasswordVerifierFromRecord(record, () => time), /^Error: VERIFIER_UNAVAILABLE$/);
  }
  const secret = password();
  let broken = false;
  const verify = offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(Buffer.from(secret)),
    () => { if (broken) throw new Error("synthetic private detail"); return 1000; });
  try {
    broken = true;
    const candidate = Buffer.from(secret);
    assert.equal(await verify(candidate), false); erased(candidate);
    broken = false;
    assert.equal(await verify(Buffer.from(secret)), false);
  } finally { secret.fill(0); verify.dispose(); }
});

test("dispose or a concurrent clock fault during KDF prevents the in-flight success", async () => {
  const secret = password();
  try {
    for (const fault of ["dispose", "clock"] as const) {
      let time = 1000;
      const verify = offlinePasswordVerifierFromRecord(await createPasswordVerifierRecord(Buffer.from(secret)), () => time);
      const candidate = Buffer.from(secret);
      const pending = verify(candidate);
      if (fault === "dispose") verify.dispose();
      else { time--; assert.equal(await verify(Buffer.from(secret)), false); time = 1000; }
      assert.equal(await pending, false); erased(candidate);
      verify.dispose();
    }
  } finally { secret.fill(0); }
});

test("KDF synchronous/callback failure erases owned buffers and permanently closes verification", async t => {
  const secret = password();
  const record = await createPasswordVerifierRecord(Buffer.from(secret));
  const verify = offlinePasswordVerifierFromRecord(record);
  let captured: Buffer | undefined;
  let returned: Buffer | undefined;
  let synchronous = true;
  t.mock.method(crypto, "scrypt", ((input: Buffer, _salt: Buffer, _length: number, _options: unknown,
    callback: (error: Error | null, key: Buffer) => void) => {
    captured = input;
    if (synchronous) throw new Error("synthetic private detail");
    returned = Buffer.alloc(32, 1);
    queueMicrotask(() => callback(new Error("synthetic private detail"), returned!));
  }) as typeof crypto.scrypt);
  syncBuiltinESMExports();
  try {
    for (const sync of [true, false]) {
      synchronous = sync;
      const enrollment = Buffer.from(secret);
      await assert.rejects(createPasswordVerifierRecord(enrollment), /^Error: VERIFIER_UNAVAILABLE$/);
      erased(enrollment); erased(captured!);
      if (returned) erased(returned);
    }
    const candidate = Buffer.from(secret);
    assert.equal(await verify(candidate), false); erased(candidate); erased(captured!); erased(returned!);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    try { assert.equal(await verify(Buffer.from(secret)), false); }
    finally { verify.dispose(); secret.fill(0); }
  }
});
