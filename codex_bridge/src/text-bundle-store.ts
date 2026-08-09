import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DataClassification, StagedTextArtifact, TextArtifactSummary } from "./types.js";

export const TEXT_BUNDLE_MAX_FILES = 8;
export const TEXT_BUNDLE_MAX_CHARS = 500_000;
export const TEXT_BUNDLE_MAX_BYTES = 2_000_000;
export const TEXT_BUNDLE_MAX_CHUNK_CHARS = 20_000;
export const TEXT_BUNDLE_MAX_CHUNK_BYTES = 80_000;
export const TEXT_BUNDLE_MAX_CHUNKS = 256;

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".log", ".json", ".yaml", ".yml", ".diff", ".patch"]);
const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/yaml",
  "text/yaml",
  "text/x-diff",
  "text/x-patch",
]);

export interface BeginTextBundleInput {
  clientTransferId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  dataClassification: DataClassification;
  totalChars: number;
  totalBytes: number;
  sha256: string;
  chunkCount: number;
}

export interface TextBundleRecord extends TextArtifactSummary {
  schemaVersion: 1;
  clientTransferId: string;
  projectId: string;
  dataClassification: DataClassification;
  totalChars: number;
  totalBytes: number;
  chunkCount: number;
  receivedChunks: number[];
  status: "open" | "finalized";
  createdAt: string;
  updatedAt: string;
}

export class TextBundleStore {
  private readonly bundles = new Map<string, TextBundleRecord>();
  private readonly clientTransfers = new Map<string, string>();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly stagingDir: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.stagingDir, { recursive: true });
    const entries = await readdir(this.stagingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(this.manifestPath(entry.name), "utf8")) as TextBundleRecord;
        if (record.schemaVersion !== 1 || record.id !== entry.name || !isUuid(record.clientTransferId)) continue;
        this.bundles.set(record.id, record);
        this.clientTransfers.set(record.clientTransferId, record.id);
      } catch {
        // One malformed staging directory must not block the bridge runtime.
      }
    }
  }

  async begin(input: BeginTextBundleInput): Promise<{ bundle: TextBundleRecord; created: boolean }> {
    return this.exclusive(async () => {
      const normalized = normalizeBeginInput(input);
      const existingId = this.clientTransfers.get(normalized.clientTransferId);
      if (existingId) {
        const existing = this.requireBundle(existingId);
        if (!sameDeclaration(existing, normalized)) {
          throw new Error("The client transfer id was already used for a different text artifact.");
        }
        return { bundle: structuredClone(existing), created: false };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const record: TextBundleRecord = {
        schemaVersion: 1,
        id,
        clientTransferId: normalized.clientTransferId,
        projectId: normalized.projectId,
        fileName: normalized.fileName,
        mimeType: normalized.mimeType,
        dataClassification: normalized.dataClassification,
        sha256: normalized.sha256,
        chars: normalized.totalChars,
        bytes: normalized.totalBytes,
        totalChars: normalized.totalChars,
        totalBytes: normalized.totalBytes,
        chunkCount: normalized.chunkCount,
        receivedChunks: [],
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      await mkdir(this.chunksDir(id), { recursive: true });
      await this.writeManifest(record);
      this.bundles.set(id, record);
      this.clientTransfers.set(record.clientTransferId, id);
      return { bundle: structuredClone(record), created: true };
    });
  }

  async append(bundleId: string, index: number, content: string, sha256: string): Promise<TextBundleRecord> {
    return this.exclusive(async () => {
      const record = this.requireBundle(bundleId);
      if (record.status !== "open") throw new Error("The text artifact is already finalized.");
      if (!Number.isInteger(index) || index < 0 || index >= record.chunkCount) {
        throw new Error(`Chunk index must be between 0 and ${record.chunkCount - 1}.`);
      }
      if (!content || content.length > TEXT_BUNDLE_MAX_CHUNK_CHARS || Buffer.byteLength(content, "utf8") > TEXT_BUNDLE_MAX_CHUNK_BYTES) {
        throw new Error(`Each text chunk must be between 1 and ${TEXT_BUNDLE_MAX_CHUNK_CHARS} characters.`);
      }
      const normalizedHash = normalizeSha256(sha256, "chunk sha256");
      const actualHash = digestText(content);
      if (actualHash !== normalizedHash) throw new Error(`Chunk ${index} SHA-256 does not match its content.`);

      const path = this.chunkPath(bundleId, index);
      if (record.receivedChunks.includes(index)) {
        const existing = await readFile(path, "utf8");
        if (digestText(existing) !== normalizedHash || existing !== content) {
          throw new Error(`Chunk ${index} was already uploaded with different content.`);
        }
        return structuredClone(record);
      }

      await writeFile(path, content, "utf8");
      record.receivedChunks.push(index);
      record.receivedChunks.sort((left, right) => left - right);
      record.updatedAt = new Date().toISOString();
      await this.writeManifest(record);
      return structuredClone(record);
    });
  }

  async finalize(bundleId: string): Promise<TextBundleRecord> {
    return this.exclusive(async () => {
      const record = this.requireBundle(bundleId);
      if (record.status === "finalized") return structuredClone(record);
      if (record.receivedChunks.length !== record.chunkCount) {
        throw new Error(`Text artifact is incomplete: received ${record.receivedChunks.length} of ${record.chunkCount} chunks.`);
      }
      const chunks = await Promise.all(
        Array.from({ length: record.chunkCount }, (_, index) => readFile(this.chunkPath(bundleId, index), "utf8")),
      );
      const content = chunks.join("");
      if (content.length !== record.totalChars || Buffer.byteLength(content, "utf8") !== record.totalBytes) {
        throw new Error("Final text artifact size does not match the declared character and byte counts.");
      }
      if (digestText(content) !== record.sha256) throw new Error("Final text artifact SHA-256 does not match.");
      if (containsHardSecret(content)) {
        throw new Error("The text artifact appears to contain an API key, bearer token, or assigned secret. Remove it before sending.");
      }
      if (content.includes("\0")) throw new Error("Text artifacts cannot contain NUL characters.");

      await writeFile(this.contentPath(bundleId), content, "utf8");
      record.status = "finalized";
      record.updatedAt = new Date().toISOString();
      await this.writeManifest(record);
      return structuredClone(record);
    });
  }

  async resolveMany(
    bundleIds: string[],
    projectId: string,
    dataClassification: DataClassification,
  ): Promise<StagedTextArtifact[]> {
    if (bundleIds.length > TEXT_BUNDLE_MAX_FILES) throw new Error(`A message can include at most ${TEXT_BUNDLE_MAX_FILES} text artifacts.`);
    if (new Set(bundleIds).size !== bundleIds.length) throw new Error("Text artifact bundle ids must be unique.");
    const artifacts: StagedTextArtifact[] = [];
    let totalBytes = 0;
    for (const bundleId of bundleIds) {
      const record = this.requireBundle(bundleId);
      if (record.status !== "finalized") throw new Error(`Text artifact '${record.fileName}' is not finalized.`);
      if (record.projectId !== projectId) throw new Error(`Text artifact '${record.fileName}' belongs to another project.`);
      if (record.dataClassification !== dataClassification) {
        throw new Error(`Text artifact '${record.fileName}' does not match the selected data classification.`);
      }
      const content = await readFile(this.contentPath(record.id), "utf8");
      if (digestText(content) !== record.sha256) throw new Error(`Text artifact '${record.fileName}' failed its stored SHA-256 check.`);
      totalBytes += record.bytes;
      if (totalBytes > TEXT_BUNDLE_MAX_BYTES) throw new Error("Combined text artifacts exceed 2,000,000 UTF-8 bytes.");
      artifacts.push({
        id: record.id,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sha256: record.sha256,
        chars: record.chars,
        bytes: record.bytes,
        content,
      });
    }
    return artifacts;
  }

  private requireBundle(bundleId: string): TextBundleRecord {
    if (!isUuid(bundleId)) throw new Error("Invalid text artifact bundle id.");
    const record = this.bundles.get(bundleId.toLowerCase()) ?? this.bundles.get(bundleId);
    if (!record) throw new Error(`Unknown text artifact bundle '${bundleId}'.`);
    return record;
  }

  private async writeManifest(record: TextBundleRecord): Promise<void> {
    const path = this.manifestPath(record.id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST") throw error;
      await copyFile(temp, path);
      await unlink(temp).catch(() => undefined);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lock.then(operation, operation);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private bundleDir(bundleId: string): string { return join(this.stagingDir, bundleId); }
  private chunksDir(bundleId: string): string { return join(this.bundleDir(bundleId), "chunks"); }
  private manifestPath(bundleId: string): string { return join(this.bundleDir(bundleId), "manifest.json"); }
  private contentPath(bundleId: string): string { return join(this.bundleDir(bundleId), "content.txt"); }
  private chunkPath(bundleId: string, index: number): string { return join(this.chunksDir(bundleId), `${index.toString().padStart(4, "0")}.txt`); }
}

function normalizeBeginInput(input: BeginTextBundleInput): BeginTextBundleInput {
  const clientTransferId = input.clientTransferId.trim().toLowerCase();
  if (!isUuid(clientTransferId)) throw new Error("clientTransferId must be a UUID.");
  const projectId = input.projectId.trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(projectId)) throw new Error("Invalid project id.");
  const fileName = normalizeFileName(input.fileName);
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported text MIME type '${mimeType}'.`);
  if (!Number.isInteger(input.totalChars) || input.totalChars < 1 || input.totalChars > TEXT_BUNDLE_MAX_CHARS) {
    throw new Error(`Text artifact must contain between 1 and ${TEXT_BUNDLE_MAX_CHARS} characters.`);
  }
  if (!Number.isInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > TEXT_BUNDLE_MAX_BYTES) {
    throw new Error(`Text artifact must contain between 1 and ${TEXT_BUNDLE_MAX_BYTES} UTF-8 bytes.`);
  }
  if (!Number.isInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkCount > TEXT_BUNDLE_MAX_CHUNKS) {
    throw new Error(`chunkCount must be between 1 and ${TEXT_BUNDLE_MAX_CHUNKS}.`);
  }
  if (!(["personal", "public", "company_approved"] as string[]).includes(input.dataClassification)) {
    throw new Error("Unsupported data classification.");
  }
  return { ...input, clientTransferId, projectId, fileName, mimeType, sha256: normalizeSha256(input.sha256, "sha256") };
}

function normalizeFileName(input: string): string {
  const fileName = input.trim().normalize("NFC");
  if (!fileName || fileName.length > 120 || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..") || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw new Error("Text artifact filename is invalid.");
  }
  if (!ALLOWED_EXTENSIONS.has(extname(fileName).toLowerCase())) {
    throw new Error("Text artifact extension must be txt, md, log, json, yaml, yml, diff, or patch.");
  }
  return fileName;
}

function normalizeSha256(value: string, field: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${field} must be a lowercase SHA-256 hex digest.`);
  return hash;
}

function sameDeclaration(record: TextBundleRecord, input: BeginTextBundleInput): boolean {
  return record.projectId === input.projectId && record.fileName === input.fileName && record.mimeType === input.mimeType &&
    record.dataClassification === input.dataClassification && record.totalChars === input.totalChars &&
    record.totalBytes === input.totalBytes && record.sha256 === input.sha256 && record.chunkCount === input.chunkCount;
}

function containsHardSecret(content: string): boolean {
  return /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/.test(content) ||
    /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i.test(content) ||
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=\s*[^\s$<{][^\s]{7,}/.test(content);
}

function digestText(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
