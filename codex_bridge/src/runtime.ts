import { readFile } from "node:fs/promises";
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
  close: () => Promise<void>;
}

export async function createBridgeRuntime(config: BridgeConfig): Promise<BridgeRuntime> {
  // Do this before JobStore/text-bundle initialization. Source binding is not a cutover grant.
  await assertInstalledRuntimeActivation(config.installedBinding);
  const store = new JobStore(config.jobsDir, config.handoffDir);
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const widgetHtml = await readFile(config.widgetPath, "utf8");
  // One component-owned App Server is shared by all Bridge threads. Per-turn cancellation belongs
  // to CodexBridgeController.cancel() and turn/interrupt; this client is never a thread process.
  const appServer = new CodexAppServerClient({
    command: config.codexCommand,
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
  const hostTransport = hostPort ? createNativeHostTransport(hostPort, config.installedBinding) : undefined;
  const powershellHost = hostPort;
  // Preflight is an explicit diagnostic action. Startup and pure getters never
  // launch the native helper; missing owner/platform leaves NORMAL/ADMIN closed.
  let closing: Promise<void> | undefined;
  return { config, store, textBundles, controller, conversations, widgetHtml, privilegedBroker, selfReload, selfReloadHtml,
    ...review, powershellHost, powershellHostTransport: hostTransport, close: () => closing ??= closeResources([
      async () => { await hostTransport?.close(); }, () => selfReload.close(), () => privilegedBroker.close(),
      () => controller.close(), async () => {
        if (!review.approvalStore) return;
        await review.approvalStore.close();
        if ((await review.approvalStore.lockDiagnostics()).presence !== "ABSENT") throw new Error("STORE_CLEANUP_UNCERTAIN");
      },
    ]) };
}
