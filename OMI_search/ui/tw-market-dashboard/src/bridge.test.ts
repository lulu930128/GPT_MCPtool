import assert from "node:assert/strict";
import test from "node:test";

import { McpAppsBridge } from "./bridge";

test("initializes the MCP Apps bridge before requesting fullscreen", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const timeline: string[] = [];
  let initializeParams: Record<string, unknown> | null = null;
  let fullscreenOptions: Record<string, unknown> | null = null;

  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const parent = {
    postMessage(message: Record<string, unknown>) {
      timeline.push(String(message.method));
      if (message.method !== "ui/initialize") return;
      initializeParams = message.params as Record<string, unknown>;
      queueMicrotask(() => dispatch("message", {
        source: parent,
        data: {
          jsonrpc: "2.0",
          id: message.id,
          result: { hostCapabilities: {} },
        },
      }));
    },
  };
  const fakeWindow = {
    parent,
    innerWidth: 768,
    innerHeight: 1_439,
    openai: {
      displayMode: "inline",
      maxHeight: undefined,
      async requestDisplayMode(options: Record<string, unknown>) {
        timeline.push("requestDisplayMode");
        fullscreenOptions = options;
        return undefined;
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    setTimeout,
    clearTimeout,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });

  const bridge = new McpAppsBridge();
  try {
    bridge.start();
    for (let attempt = 0; attempt < 10 && fullscreenOptions === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.deepEqual(initializeParams, {
      appInfo: { name: "omi-tw-market-dashboard", version: "1.1.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    });
    assert.equal(Object.hasOwn(initializeParams!, "clientInfo"), false);
    assert.equal(Object.hasOwn(initializeParams!, "capabilities"), false);
    assert.deepEqual(fullscreenOptions, { mode: "fullscreen" });
    assert.deepEqual(timeline.slice(0, 3), [
      "ui/initialize",
      "ui/notifications/initialized",
      "requestDisplayMode",
    ]);
    assert.deepEqual(bridge.getPresentationDiagnostic(), {
      initializeStatus: "success",
      initializeError: null,
      requestStatus: "success",
      requestSource: "auto",
      requestResult: "fulfilled (no payload)",
      requestError: null,
      apiAvailable: true,
      actualDisplayMode: "inline",
      viewportWidth: 768,
      viewportHeight: 1_439,
      maxHeight: null,
      updatedAt: bridge.getPresentationDiagnostic().updatedAt,
    });
  } finally {
    bridge.stop();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
