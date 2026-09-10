import path from "node:path";
import type { ServerConfig } from "./config.js";
import { fetchAsset, type FetchAssetArgs } from "./file-transfer.js";
import { WorkspaceAccessError } from "./path-guard.js";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac"]);

export type ReadAudioArgs = FetchAssetArgs;

export async function readAudioAsset(config: ServerConfig, args: ReadAudioArgs) {
  if (!AUDIO_EXTENSIONS.has(path.extname(args.path.trim()).toLowerCase())) {
    throw new WorkspaceAccessError("read_audio supports WAV, MP3, OGG, and FLAC files only.");
  }

  // Keep original-byte authorization, containment and bounded reads in one owner.
  const fetched = await fetchAsset(config, args);
  if (!fetched.mimeType.startsWith("audio/")) {
    throw new WorkspaceAccessError(`Unsupported audio MIME type: ${fetched.mimeType}.`);
  }
  return {
    metadata: {
      ok: true as const,
      scope: fetched.metadata.scope,
      path: fetched.metadata.path,
      filename: fetched.metadata.filename,
      bytes: fetched.metadata.bytes,
      mimeType: fetched.mimeType,
      sha256: fetched.metadata.sha256,
      transport: "audio_content" as const,
    },
    data: fetched.data,
    mimeType: fetched.mimeType,
  };
}
