import { readFile } from "node:fs/promises";
import { CodexAppServerClient } from "./app-server-client.js";
import type { BridgeConfig } from "./config.js";
import { CodexBridgeController } from "./controller.js";
import { JobStore } from "./job-store.js";
import { TextBundleStore } from "./text-bundle-store.js";

export interface BridgeRuntime {
  config: BridgeConfig;
  store: JobStore;
  textBundles: TextBundleStore;
  controller: CodexBridgeController;
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
  return { config, store, textBundles, controller, widgetHtml, close: () => controller.close() };
}
