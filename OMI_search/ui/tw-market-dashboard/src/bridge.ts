type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
};

export type DisplayMode = "inline" | "pip" | "fullscreen";
export type DiagnosticStatus = "idle" | "pending" | "success" | "error" | "unavailable";

export type PresentationDiagnostic = {
  initializeStatus: DiagnosticStatus;
  initializeError: string | null;
  requestStatus: DiagnosticStatus;
  requestSource: "auto" | "manual" | null;
  requestResult: string;
  requestError: string | null;
  apiAvailable: boolean;
  actualDisplayMode: DisplayMode | "unknown";
  viewportWidth: number;
  viewportHeight: number;
  maxHeight: number | null;
  updatedAt: string;
};

declare global {
  interface Window {
    openai?: {
      toolInput?: unknown;
      toolOutput?: unknown;
      callTool?: (name: string, arguments_: Record<string, unknown>) => Promise<unknown>;
      widgetState?: unknown;
      setWidgetState?: (state: unknown) => void;
      displayMode?: DisplayMode;
      maxHeight?: number;
      requestDisplayMode?: (options: { mode: DisplayMode }) => Promise<unknown>;
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown host error";
  }
}

function summarizeResult(value: unknown): string {
  if (value === undefined) return "fulfilled (no payload)";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function readDisplayMode(): DisplayMode | "unknown" {
  const mode = window.openai?.displayMode;
  return mode === "inline" || mode === "pip" || mode === "fullscreen" ? mode : "unknown";
}

function readMaxHeight(): number | null {
  const value = window.openai?.maxHeight;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createInitialDiagnostic(): PresentationDiagnostic {
  return {
    initializeStatus: "idle",
    initializeError: null,
    requestStatus: "idle",
    requestSource: null,
    requestResult: "尚未送出",
    requestError: null,
    apiAvailable: typeof window.openai?.requestDisplayMode === "function",
    actualDisplayMode: readDisplayMode(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    maxHeight: readMaxHeight(),
    updatedAt: new Date().toISOString(),
  };
}

export class McpAppsBridge {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(value: unknown) => void>();
  private readonly presentationListeners = new Set<(value: PresentationDiagnostic) => void>();
  private readonly presentationCaptureTimers = new Set<number>();
  private presentation = createInitialDiagnostic();
  private bridgeReady: Promise<void> | null = null;
  private started = false;

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || message.jsonrpc !== "2.0") return;
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timeout);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      const params = message.params as Record<string, unknown> | undefined;
      this.emit(params?.structuredContent);
    }
  };

  private readonly onHostGlobals = () => this.refreshPresentationEnvironment();
  private readonly onViewportChange = () => this.refreshPresentationEnvironment();

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("message", this.onMessage, { passive: true });
    window.addEventListener("openai:set_globals", this.onHostGlobals, { passive: true });
    window.addEventListener("resize", this.onViewportChange, { passive: true });
    this.refreshPresentationEnvironment();
    const compatibilityOutput = window.openai?.toolOutput;
    if (compatibilityOutput !== undefined) this.emit(compatibilityOutput);
    this.bridgeReady = this.initializeHost();
    void this.bridgeReady.then(() => {
      if (this.started) return this.requestFullscreen("auto");
      return undefined;
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("openai:set_globals", this.onHostGlobals);
    window.removeEventListener("resize", this.onViewportChange);
    for (const timer of this.presentationCaptureTimers) window.clearTimeout(timer);
    this.presentationCaptureTimers.clear();
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Widget bridge stopped"));
    }
    this.pending.clear();
    this.bridgeReady = null;
  }

  subscribe(listener: (value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getPresentationDiagnostic(): PresentationDiagnostic {
    return this.presentation;
  }

  subscribePresentation(listener: (value: PresentationDiagnostic) => void): () => void {
    this.presentationListeners.add(listener);
    listener(this.presentation);
    return () => this.presentationListeners.delete(listener);
  }

  async requestFullscreen(source: "auto" | "manual" = "manual"): Promise<PresentationDiagnostic> {
    this.updatePresentation({
      requestStatus: "pending",
      requestSource: source,
      requestResult: "waiting for host",
      requestError: null,
    });
    if (typeof window.openai?.requestDisplayMode !== "function") {
      this.updatePresentation({
        requestStatus: "unavailable",
        requestResult: "window.openai.requestDisplayMode unavailable",
      });
      return this.presentation;
    }
    try {
      const result = await window.openai.requestDisplayMode({ mode: "fullscreen" });
      if (!this.started) return this.presentation;
      this.updatePresentation({
        requestStatus: "success",
        requestResult: summarizeResult(result),
        requestError: null,
      });
      this.schedulePresentationCaptures();
    } catch (error) {
      if (!this.started) return this.presentation;
      this.updatePresentation({
        requestStatus: "error",
        requestResult: "host rejected request",
        requestError: errorMessage(error),
      });
    }
    return this.presentation;
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const bridgeReady = this.bridgeReady;
    if (bridgeReady) await bridgeReady;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await this.request(
        "tools/call",
        { name, arguments: arguments_ },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (window.openai?.callTool) {
        return window.openai.callTool(name, arguments_);
      }
      throw error;
    }
  }

  private async initializeHost(): Promise<void> {
    this.updatePresentation({ initializeStatus: "pending", initializeError: null });
    try {
      await this.request("ui/initialize", {
        appInfo: { name: "omi-tw-market-dashboard", version: "1.1.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      });
      if (!this.started) return;
      this.notify("ui/notifications/initialized", {});
      this.updatePresentation({ initializeStatus: "success", initializeError: null });
    } catch (error) {
      if (!this.started) return;
      this.updatePresentation({
        initializeStatus: "error",
        initializeError: errorMessage(error),
      });
    }
  }

  private refreshPresentationEnvironment(): void {
    this.updatePresentation({});
  }

  private schedulePresentationCaptures(): void {
    for (const delay of [100, 500, 1_500]) {
      const timer = window.setTimeout(() => {
        this.presentationCaptureTimers.delete(timer);
        if (this.started) this.refreshPresentationEnvironment();
      }, delay);
      this.presentationCaptureTimers.add(timer);
    }
  }

  private updatePresentation(
    patch: Partial<Omit<PresentationDiagnostic, "apiAvailable" | "actualDisplayMode" | "viewportWidth" | "viewportHeight" | "maxHeight" | "updatedAt">>,
  ): void {
    this.presentation = {
      ...this.presentation,
      ...patch,
      apiAvailable: typeof window.openai?.requestDisplayMode === "function",
      actualDisplayMode: readDisplayMode(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxHeight: readMaxHeight(),
      updatedAt: new Date().toISOString(),
    };
    for (const listener of this.presentationListeners) listener(this.presentation);
  }

  private emit(value: unknown): void {
    for (const listener of this.listeners) listener(value);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timeout });
      signal?.addEventListener(
        "abort",
        () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          window.clearTimeout(pending.timeout);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
}
