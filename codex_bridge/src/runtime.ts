import { readFile } from "node:fs/promises";
import { CodexAppServerClient } from "./app-server-client.js";
import type { BridgeConfig } from "./config.js";
import { CodexBridgeController } from "./controller.js";
import { JobStore } from "./job-store.js";
import { TextBundleStore } from "./text-bundle-store.js";
import { AutomationRegistry } from "./automation-registry.js";
import { UnifiedConversationRegistry } from "./unified-conversation-registry.js";

export interface BridgeRuntime {
  config: BridgeConfig;
  store: JobStore;
  textBundles: TextBundleStore;
  controller: CodexBridgeController;
  conversations: UnifiedConversationRegistry;
  widgetHtml: string;
  close: () => Promise<void>;
}

export async function createBridgeRuntime(config: BridgeConfig): Promise<BridgeRuntime> {
  const store = new JobStore(config.jobsDir, config.handoffDir);
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const widgetHtml = await readFile(config.widgetPath, "utf8");
  const appServer = new CodexAppServerClient({
    command: config.codexCommand,
    args: config.codexArgs,
  });
  const controller = new CodexBridgeController(config, store, textBundles, appServer);
  const automations = new AutomationRegistry(config.codexHome);
  const conversations = new UnifiedConversationRegistry(config, store, controller, automations);
  return { config, store, textBundles, controller, conversations, widgetHtml, close: () => controller.close() };
}
