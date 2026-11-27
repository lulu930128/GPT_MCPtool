import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { MemoryMaintenance, type MaintenanceWork } from "./memory-maintenance.js";
import { join } from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";
import type { BridgeConfig } from "./config.js";
import { CodexBridgeController } from "./controller.js";
import { JobStore } from "./job-store.js";
import { TextBundleStore } from "./text-bundle-store.js";
import { AutomationRegistry } from "./automation-registry.js";
import { UnifiedConversationRegistry } from "./unified-conversation-registry.js";
import { RemotePrivilegedBroker } from "./privileged/broker.js";
import { SelfReloadClient } from "./self-reload/client.js";
import { assertInstalledRuntimeActivation } from "./installed-runtime.js";
import type { ApprovalStore } from "./powershell-approval/store.js";
import { initializePowerShellReview } from "./powershell-approval/review-runtime.js";
import { closeResources } from "./close-resources.js";
import type { ReviewStoreDiagnostics } from "./powershell-approval/review-runtime.js";
import { createPowerShellHostPort, type PowerShellHostPort } from "./powershell-approval/host-admission.js";
import { createNativeHostTransport } from "./powershell-approval/host-transport.js";

export interface BridgeRuntime {
  diagnostics?: RuntimeDiagnostics;
  config: BridgeConfig;
  store: JobStore;
  textBundles: TextBundleStore;
  controller: CodexBridgeController;
  conversations: UnifiedConversationRegistry;
  widgetHtml: string;
  privilegedBroker: RemotePrivilegedBroker;
  selfReload?: SelfReloadClient;
  selfReloadHtml?: string;
  approvalStore?: ApprovalStore;
  powershellReviewUnavailable?: string;
  reviewStoreDiagnostics?: () => Promise<ReviewStoreDiagnostics>;
  powershellHost?: PowerShellHostPort;
  // Explicit installed lifecycle/operator boundary, never called by read-only tools.
  powershellHostTransport?: ReturnType<typeof createNativeHostTransport>;
  memoryMaintenance?: MemoryMaintenance;
  activity?: { tools: number; http: number };
  maintenanceWork?: () => MaintenanceWork;
  close: () => Promise<void>;
}

export async function createBridgeRuntime(config: BridgeConfig, diagnostics?: RuntimeDiagnostics): Promise<BridgeRuntime> {
  // Do this before JobStore/text-bundle initialization. Source binding is not a cutover grant.
  await assertInstalledRuntimeActivation(config.installedBinding);
  const store = new JobStore(config.jobsDir, config.handoffDir, undefined, diagnostics);
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const widgetHtml = await readFile(config.widgetPath, "utf8");
  // One component-owned App Server is shared by all Bridge threads. Per-turn cancellation belongs
  // to CodexBridgeController.cancel() and turn/interrupt; this client is never a thread process.
  const appServer = new CodexAppServerClient({
    diagnostics, command: config.codexCommand,
    args: config.codexArgs,
    environment: config.codexEnvironment,
    beforeSpawn: config.installedBinding ? () => assertInstalledRuntimeActivation(config.installedBinding) : undefined,
  });
  const controller = new CodexBridgeController(config, store, textBundles, appServer);
  const automations = new AutomationRegistry(config.codexHome);
  const conversations = new UnifiedConversationRegistry(config, store, controller, automations);
  const privilegedBroker = RemotePrivilegedBroker.notConfigured();
  const selfReload = new SelfReloadClient(store);
  const selfReloadHtml = await readFile(join(config.projectRoot, "web", "self-reload.html"), "utf8");
  // Single canonical journal owner for this runtime; no production broker/runner is opened.
  // Review failures must not prevent ordinary Codex engineering work from starting.
  const review = await initializePowerShellReview(config.dataDir);
  const hostPort = review.approvalStore ? createPowerShellHostPort({ store: review.approvalStore,
    projects: config.projects, readJob: id => store.snapshot(id) }) : undefined;
  const hostTransport = hostPort ? createNativeHostTransport(hostPort, config.installedBinding, config.projectRoot) : undefined;
  const powershellHost = hostPort;
  const activity = { tools: 0, http: 0 };
  const maintenanceWork = (): MaintenanceWork => {
    const counts = store.jobCounts();
    return { jobs: counts.active,
      approvals: counts.approvals, operations: store.pendingAdmissions,
      tools: activity.tools, http: activity.http, background: controller.maintenancePending + (hostTransport?.status().active || hostTransport?.status().closed ? 1 : 0),
      controllerReady: ["idle", "ready"].includes(controller.status) };
  };
  const memoryMaintenance = new MemoryMaintenance(store, config.dataDir, {
    pid: process.pid, instance: diagnostics?.instance ?? randomUUID(), buildId: config.buildId, startedAt: new Date().toISOString(),
  }, maintenanceWork);
  await memoryMaintenance.initialize();
  if (diagnostics) diagnostics.workload = () => ({
    store: store.workload(), appServer:appServer.workload(), controller: controller.pipelineWorkload(), native: conversations.cacheWorkload(),
    maintenance: memoryMaintenance.snapshot(), http: activity.http, tools: activity.tools,
  });
  memoryMaintenance.start();
  controller.startReconciliation();
  // Preflight is an explicit diagnostic action. Startup and pure getters never
  // launch the native helper; missing owner/platform leaves NORMAL/ADMIN closed.
  let closing: Promise<void> | undefined;
  return { diagnostics, config, store, textBundles, controller, conversations, widgetHtml, privilegedBroker, selfReload, selfReloadHtml,
    memoryMaintenance, activity, maintenanceWork,
    ...review, powershellHost, powershellHostTransport: hostTransport, close: () => closing ??= closeResources([
      () => memoryMaintenance.close(), async () => { await hostTransport?.close(); }, () => selfReload.close(), () => privilegedBroker.close(),
      () => controller.close(), async () => {
        if (!review.approvalStore) return;
        await review.approvalStore.close();
        if ((await review.approvalStore.lockDiagnostics()).presence !== "ABSENT") throw new Error("STORE_CLEANUP_UNCERTAIN");
      },
    ]) };
}
