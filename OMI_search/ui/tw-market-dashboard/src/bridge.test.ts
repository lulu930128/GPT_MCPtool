import assert from "node:assert/strict";
import test from "node:test";

import { McpAppsBridge } from "./bridge";

test("resize feedback publishes only meaningful diagnostics and cleans up listeners/captures", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let fullscreenRequests = 0;
  let publications = 0;
  const parent = {
    postMessage(message: { method: string; id: number }) {
      if (message.method === "ui/initialize") queueMicrotask(() => {
        const event = new Event("message");
        Object.assign(event, { source: parent, data: { jsonrpc: "2.0", id: message.id, result: {} } });
        events.dispatchEvent(event);
      });
    },
  };
  const host = {
    parent, innerWidth: 1440, innerHeight: 700,
    openai: { displayMode: "inline", maxHeight: 700,
      async requestDisplayMode() { fullscreenRequests++; return {}; } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  const bridge = new McpAppsBridge();
  const unsubscribe = bridge.subscribePresentation(() => publications++);
  try {
    bridge.start();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(fullscreenRequests, 1);
    assert.equal(bridge.getPresentationDiagnostic().actualDisplayMode, "inline", "fulfilled request does not imply fullscreen");
    const stable = bridge.getPresentationDiagnostic();
    const baseline = publications;
    for (let i = 0; i < 20; i++) {
      events.dispatchEvent(new Event("resize"));
      events.dispatchEvent(new Event("openai:set_globals"));
    }
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    assert.equal(publications, baseline);
    assert.equal(bridge.getPresentationDiagnostic(), stable, "same object and updatedAt");
    for (const mode of ["fullscreen", "pip", "invalid-mode", "inline"]) {
      host.openai.displayMode = mode;
      host.innerHeight += 10;
      host.openai.maxHeight = host.innerHeight;
      events.dispatchEvent(new Event("openai:set_globals"));
      const next = bridge.getPresentationDiagnostic();
      assert.equal(next.actualDisplayMode, mode === "invalid-mode" ? "unknown" : mode);
      assert.equal(next.viewportHeight, host.innerHeight);
      assert.equal(next.maxHeight, host.openai.maxHeight);
      const count = publications;
      for (let i = 0; i < 20; i++) events.dispatchEvent(new Event("resize"));
      assert.equal(publications, count);
      assert.equal(bridge.getPresentationDiagnostic(), next);
    }
    host.innerWidth = 390;
    events.dispatchEvent(new Event("resize"));
    assert.equal(bridge.getPresentationDiagnostic().viewportWidth, 390);
    assert.equal(publications, baseline + 5);
    assert.equal(fullscreenRequests, 1, "resize/mode changes never request fullscreen again");
    await bridge.requestFullscreen("manual");
    assert.equal(timers.size, 3);
    bridge.stop();
    assert.equal(timers.size, 0);
    const stopped = bridge.getPresentationDiagnostic();
    host.innerHeight = 5000;
    events.dispatchEvent(new Event("resize"));
    events.dispatchEvent(new Event("openai:set_globals"));
    assert.equal(bridge.getPresentationDiagnostic(), stopped);
    unsubscribe();
  } finally {
    bridge.stop();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

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
      appInfo: { name: "omi-tw-market-dashboard", version: "1.2.0" },
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
