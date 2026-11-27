import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { JobStore } from "./job-store.js";

export const MEMORY_POLICY = { thresholdBytes: 1500 * 1024 * 1024, sampleMs: 60_000, consecutive: 2, cooldownMs: 600_000 } as const;
const identity = z.object({ pid: z.number().int().positive(), instance: z.string().uuid(), buildId: z.string().min(1), startedAt: z.string().datetime() });
const stateSchema = z.object({
  contract: z.literal("bridge-memory-maintenance-v1"), intentId: z.string().uuid(),
  phase: z.enum(["draining", "ready", "restarting", "cooldown", "failed"]),
  reason: z.literal("HEAP_USED_LIMIT"), thresholdBytes: z.number().int().positive(), heapUsed: z.number().int().nonnegative(),
  triggeredAt: z.string().datetime(), old: identity, next: identity.optional(),
  completedAt: z.string().datetime().optional(), cooldownUntil: z.string().datetime().optional(),
  restartRequestedAt: z.string().datetime().optional(),
  readyAt: z.string().datetime().optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/).optional(),
});
export type MemoryIntent = z.infer<typeof stateSchema>;
export type RuntimeIdentity = z.infer<typeof identity>;
export interface MaintenanceWork { jobs: number; approvals: number; operations: number; tools: number; background: number; http: number; controllerReady: boolean }
export class MemoryMaintenanceError extends Error {
  readonly code = "MEMORY_MAINTENANCE";
  constructor(readonly maintenance: unknown) { super("不可接續任務：等待現有工作完成後自動重啟。"); }
}

/** Bridge owns admission and the intent. The existing lifecycle controller marks
 * an actual restart attempt; a healthy replacement reconciles the prior process. */
export class MemoryMaintenance {
  private state?: MemoryIntent;
  private fault?: string;
  private peaks = 0;
  private heapUsed = 0;
  private lastSample = -Infinity;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private stopped = false;
  readonly path: string;
  constructor(private readonly store: JobStore, dataDir: string, readonly identity: RuntimeIdentity,
    private readonly work: () => MaintenanceWork, private readonly now = Date.now,
    private readonly memory = () => process.memoryUsage().heapUsed,
    private readonly policy: { thresholdBytes: number; sampleMs: number; consecutive: number; cooldownMs: number } = MEMORY_POLICY,
    private readonly processExited = hasProcessExited) {
    this.path = join(dataDir, "memory-maintenance.json");
  }
  get blocked() { return Boolean(this.fault || (this.state && this.state.phase !== "cooldown")); }
  snapshot() {
    return { contract: "bridge-memory-maintenance-v1", admission: this.blocked ? "closed" : "open",
      phase: this.fault ? "failed" : this.state?.phase ?? "monitoring", reason: this.state?.reason ?? null,
      intentId: this.state?.intentId ?? null, thresholdBytes: this.policy.thresholdBytes, heapUsed: this.heapUsed,
      consecutiveSamples: this.peaks, sampleMs: this.policy.sampleMs, pendingWork: this.work(),
      cooldownUntil: this.state?.cooldownUntil ?? null, code: this.fault ?? this.state?.code ?? null,
      identity: this.identity };
  }
  async initialize() {
    this.heapUsed = this.memory();
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fault = "MAINTENANCE_STATE_UNAVAILABLE"; }
    // A prior verified success remains valid across ordinary process restarts;
    // the absolute timestamp, not process uptime, controls the cooldown.
    if (this.state?.phase === "cooldown" && (!this.state.next || !this.state.completedAt || !this.state.cooldownUntil)) this.fault = "MAINTENANCE_RESULT_INVALID";
    if (this.blocked) await this.store.setMemoryAdmission(() => this.snapshot());
  }
  /** Called only after this runtime has bound its HTTP listener. Store readiness
   * and the old PID's absence are facts, not a controller handoff acknowledgement. */
  async reconcilePreviousRuntime(storesReady: boolean) {
    await this.ticking;
    const previous = this.state;
    if (this.fault || !previous || previous.phase === "cooldown" || !storesReady
      || previous.old.instance === this.identity.instance || previous.old.pid === this.identity.pid
      || !this.processExited(previous.old.pid) || !maintenanceIdle(this.work())) return;
    await this.store.flushConversations();
    if (!maintenanceIdle(this.work())) return;
    const bytes = await readFile(this.path, "utf8");
    if (JSON.stringify(stateSchema.parse(JSON.parse(bytes))) !== JSON.stringify(previous)) throw new Error("INTENT_CHANGED");
    // Preserve the incident bytes; never delete a latch to pretend a restart succeeded.
    const archive = join(this.path, "..", `memory-maintenance.${previous.intentId}.before-reconcile.json`);
    try { await copyFile(this.path, archive, constants.COPYFILE_EXCL); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(archive, "utf8") !== bytes) throw error;
    }
    const now = this.now();
    const recovered: MemoryIntent = { ...previous, phase: "cooldown", next: this.identity,
      completedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + this.policy.cooldownMs).toISOString(),
      code: "PREVIOUS_RUNTIME_REPLACED" };
    await this.save(recovered);
    this.state = recovered;
    await this.store.clearMemoryAdmission();
  }
  start() {
    this.lastSample = this.now();
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.ticking; }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.step().catch(async () => {
      this.fault = "MAINTENANCE_STATE_UNAVAILABLE";
      await this.store.setMemoryAdmission(() => this.snapshot());
    }).finally(() => { this.ticking = undefined; });
  }
  private async step() {
    if (this.fault) return;
    // A prior process is reconciled by startup after the listener/stores are ready.
    // It must neither trigger another restart nor inherit a permanent timeout fault.
    if (this.state && this.state.phase !== "cooldown" && this.state.old.instance !== this.identity.instance) return;
    if (this.state && this.state.phase !== "draining" && this.state.phase !== "cooldown") {
      const disk = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      if (disk.intentId !== this.state.intentId || JSON.stringify(disk.old) !== JSON.stringify(this.state.old)) throw new Error("INTENT_CHANGED");
      if (disk.phase === "cooldown") {
        if (!disk.next || disk.next.instance !== this.identity.instance || disk.next.pid !== this.identity.pid
          || disk.next.buildId !== this.identity.buildId || disk.next.startedAt !== this.identity.startedAt
          || !disk.completedAt || !disk.cooldownUntil
          || Date.parse(disk.cooldownUntil) - Date.parse(disk.completedAt) < this.policy.cooldownMs) throw new Error("RESULT_INVALID");
        this.state = disk;
        await this.store.clearMemoryAdmission();
      } else if (["ready", "restarting", "failed"].includes(disk.phase)) this.state = disk;
    }
    const now = this.now();
    if (now - this.lastSample >= this.policy.sampleMs) {
      this.lastSample = now; this.heapUsed = this.memory();
      if (!Number.isSafeInteger(this.heapUsed) || this.heapUsed < 0) throw new Error("MEMORY_INVALID");
      if (!this.blocked && (!this.state?.cooldownUntil || now >= Date.parse(this.state.cooldownUntil))) {
        this.peaks = this.heapUsed > this.policy.thresholdBytes ? this.peaks + 1 : 0;
        if (this.peaks >= this.policy.consecutive) {
          const intent: MemoryIntent = { contract: "bridge-memory-maintenance-v1", intentId: randomUUID(), phase: "draining",
            reason: "HEAP_USED_LIMIT", thresholdBytes: this.policy.thresholdBytes, heapUsed: this.heapUsed,
            triggeredAt: new Date(now).toISOString(), old: this.identity };
          await this.store.setMemoryAdmission(() => this.snapshot(), async () => { this.state = intent; await this.save(); });
        }
      } else this.peaks = 0;
    }
    if (this.state?.phase === "draining") {
      if (this.state.old.instance !== this.identity.instance) { this.fault = "RESTART_NOT_VERIFIED"; return; }
      if (!maintenanceIdle(this.work())) return;
      await this.store.flushConversations();
      if (!maintenanceIdle(this.work())) return;
      // Publish ready only AFTER its bytes are durable. CC may sample health at
      // any await boundary and must never consume an uncommitted readiness claim.
      const ready: MemoryIntent = { ...this.state, phase: "ready", readyAt: new Date(this.now()).toISOString() };
      await this.save(ready);
      this.state = ready;
    }
  }
  private async save(state = this.state) {
    await mkdir(join(this.path, ".."), { recursive: true });
    const temporary = this.path + ".bridge.tmp";
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(state) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.path);
    if (state) {
      this.store.diagnostics?.observe("maintenance", state.phase, {intentId:state.intentId,bytes:state.heapUsed});
      this.store.diagnostics?.record("maintenance_transition");
    }
  }
}
function hasProcessExited(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export function maintenanceIdle(work: MaintenanceWork) {
  return work.controllerReady && [work.jobs, work.approvals, work.operations, work.tools, work.background, work.http].every(n => n === 0);
}
