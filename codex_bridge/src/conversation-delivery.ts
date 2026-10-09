import type { ConversationProjectionPatch } from "./types.js";

// Shared server policy; the widget consumes the catch-up limits from snapshots.
export const CONVERSATION_DELIVERY = Object.freeze({
  coalesceMs: 150,
  maxDeltaRevisions: 40,
  maxDeltaBytes: 512_000,
  maxReplayLag: 200,
  maxCatchUpMs: 1_500,
  maxCatchUpPages: 4,
  hotEntries: 256,
  hotBytes: 4_000_000,
  totalHotBytes: 32_000_000,
  activeQuietMs: 15_000,
  nativeRetryMs: 30_000,
});

/** Durable patches only. Cache eviction requires a snapshot, never a disk scan. */
export class RecentConversationChanges {
  private readonly jobs = new Map<string, Array<{ patch: ConversationProjectionPatch; bytes: number }>>();
  private bytes = 0;

  add(jobId: string, patch: ConversationProjectionPatch): void {
    const entries = this.jobs.get(jobId) ?? [];
    this.jobs.delete(jobId);
    const bytes = Buffer.byteLength(JSON.stringify(patch));
    entries.push({ patch: structuredClone(patch), bytes });
    this.bytes += bytes;
    let jobBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length > CONVERSATION_DELIVERY.hotEntries || jobBytes > CONVERSATION_DELIVERY.hotBytes) {
      const removed = entries.shift()!;
      jobBytes -= removed.bytes;
      this.bytes -= removed.bytes;
    }
    if (entries.length) this.jobs.set(jobId, entries);
    while (this.bytes > CONVERSATION_DELIVERY.totalHotBytes) {
      const oldest = this.jobs.keys().next().value!;
      for (const entry of this.jobs.get(oldest)!) this.bytes -= entry.bytes;
      this.jobs.delete(oldest);
    }
  }

  read(jobId: string, afterRevision: number, serverRevision: number): ConversationProjectionPatch[] | undefined {
    if (afterRevision === serverRevision) return [];
    if (afterRevision > serverRevision || serverRevision - afterRevision > CONVERSATION_DELIVERY.maxReplayLag) return undefined;
    const entries = this.jobs.get(jobId) ?? [];
    const selected: ConversationProjectionPatch[] = [];
    let bytes = 0;
    let expected = afterRevision + 1;
    for (const entry of entries) {
      if (entry.patch.revision <= afterRevision) continue;
      if (entry.patch.revision !== expected) return undefined;
      if (bytes + entry.bytes > CONVERSATION_DELIVERY.maxDeltaBytes) break;
      selected.push(entry.patch);
      bytes += entry.bytes;
      expected += 1;
      if (selected.length === CONVERSATION_DELIVERY.maxDeltaRevisions) break;
    }
    return selected.length ? structuredClone(selected) : undefined;
  }

  diagnostics(jobId: string) {
    const entries = this.jobs.get(jobId) ?? [];
    return {
      hotBufferEntries: entries.length,
      hotBufferBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      hotBufferOldestRevision: entries[0]?.patch.revision,
      hotBufferNewestRevision: entries.at(-1)?.patch.revision,
    };
  }
}

export function isCoalescibleConversationNotification(method: string): boolean {
  return ["item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta", "item/fileChange/patchUpdated", "item/mcpToolCall/progress",
    "turn/diff/updated"].includes(method);
}
