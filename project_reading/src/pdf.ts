import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { AssetArgs } from "./assets.js";
import { resolveAssetFile } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { WorkspaceAccessError } from "./path-guard.js";

export interface ReadPdfTextArgs extends AssetArgs {
  pageStart?: number;
  pageCount?: number;
  maxChars?: number;
}

export interface ReadPdfPageArgs extends AssetArgs {
  page?: number;
  maxDimension?: number;
}

export interface PdfPageImageResult {
  metadata: Record<string, unknown>;
  data: string;
  mimeType: "image/png";
}

interface PdfWorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingPdfJob {
  id: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let sharedPdfWorker: PdfWorkerClient | undefined;

export async function inspectPdf(config: ServerConfig, args: AssetArgs): Promise<unknown> {
  const asset = await readPdfSource(config, args);
  const result = await runPdfWorker(config, "inspect", asset.source, {});
  return {
    ok: true,
    scope: asset.scope,
    path: asset.path,
    bytes: asset.source.length,
    kind: "pdf",
    readableBy: ["read_pdf_text", "read_pdf_page"],
    ...(result as object),
  };
}

export async function readPdfText(
  config: ServerConfig,
  args: ReadPdfTextArgs,
): Promise<unknown> {
  const asset = await readPdfSource(config, args);
  const result = await runPdfWorker(config, "text", asset.source, {
    pageStart: args.pageStart,
    pageCount: args.pageCount,
    maxChars: args.maxChars,
  });
  return {
    ok: true,
    scope: asset.scope,
    path: asset.path,
    bytes: asset.source.length,
    ...(result as object),
  };
}

export async function readPdfPage(
  config: ServerConfig,
  args: ReadPdfPageArgs,
): Promise<PdfPageImageResult> {
  const asset = await readPdfSource(config, args);
  const result = (await runPdfWorker(config, "page", asset.source, {
    page: args.page,
    maxDimension: args.maxDimension,
  })) as Record<string, unknown>;
  const data = result.data;
  if (typeof data !== "string") {
    throw new WorkspaceAccessError("PDF renderer returned an invalid image payload.");
  }
  const { data: _data, ...metadata } = result;
  return {
    metadata: {
      ok: true,
      scope: asset.scope,
      path: asset.path,
      sourceBytes: asset.source.length,
      ...metadata,
    },
    data,
    mimeType: "image/png",
  };
}

async function readPdfSource(
  config: ServerConfig,
  args: AssetArgs,
): Promise<{ scope: string; path: string; source: Buffer }> {
  const asset = await resolveAssetFile(config, args);
  if (asset.extension !== ".pdf") {
    throw new WorkspaceAccessError("PDF tools support .pdf files only.");
  }
  if (asset.bytes > config.maxPdfFileBytes) {
    throw new WorkspaceAccessError(
      `PDF size ${asset.bytes} exceeds the limit of ${config.maxPdfFileBytes} bytes.`,
    );
  }
  const source = await fs.readFile(asset.absolute);
  if (!source.subarray(0, 1_024).includes(Buffer.from("%PDF-"))) {
    throw new WorkspaceAccessError("File extension and PDF content do not match.");
  }
  return { scope: asset.scopeId, path: asset.relative, source };
}

function runPdfWorker(
  config: ServerConfig,
  operation: "inspect" | "text" | "page",
  source: Buffer,
  args: Record<string, unknown>,
): Promise<unknown> {
  sharedPdfWorker ??= new PdfWorkerClient();
  return sharedPdfWorker.run(config, operation, source, args);
}

class PdfWorkerClient {
  private worker: Worker | undefined;
  private pending: PendingPdfJob | undefined;
  private queue: Promise<void> = Promise.resolve();
  private nextId = 1;

  run(
    config: ServerConfig,
    operation: "inspect" | "text" | "page",
    source: Buffer,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const operationPromise = this.queue.then(() =>
      this.execute(config, operation, source, args),
    );
    this.queue = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    return operationPromise;
  }

  private execute(
    config: ServerConfig,
    operation: "inspect" | "text" | "page",
    source: Buffer,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const worker = this.getWorker();
    const bytes = Uint8Array.from(source);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) {
          return;
        }
        this.pending = undefined;
        this.worker = undefined;
        void worker.terminate();
        reject(new WorkspaceAccessError(`PDF operation exceeded ${config.pdfTimeoutMs} ms.`));
      }, config.pdfTimeoutMs);
      this.pending = { id, timer, resolve, reject };
      try {
        worker.postMessage(
          {
            id,
            operation,
            bytes: bytes.buffer,
            args,
            limits: {
              maxPages: config.maxPdfPages,
              maxReadPages: config.maxPdfReadPages,
              maxTextChars: config.maxPdfTextChars,
              maxRenderDimension: config.maxPdfRenderDimension,
              maxRenderPixels: config.maxPdfRenderPixels,
              maxOutputBytes: config.maxPdfOutputBytes,
            },
          },
          [bytes.buffer],
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending = undefined;
        reject(
          new WorkspaceAccessError(
            `PDF worker could not accept the request: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(new URL("./pdf-worker.js", import.meta.url), {
      workerData: undefined,
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
      },
    });
    worker.on("message", (message: PdfWorkerReply) => {
      const pending = this.pending;
      if (!pending || pending.id !== message.id) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new WorkspaceAccessError(message.error ?? "PDF operation failed."));
      }
    });
    worker.on("error", (error) => {
      this.failWorker(worker, new WorkspaceAccessError(`PDF worker failed: ${error.message}`));
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) {
        return;
      }
      this.worker = undefined;
      if (this.pending) {
        this.failPending(
          new WorkspaceAccessError(
            code === 0
              ? "PDF worker exited before returning a result."
              : `PDF worker exited with code ${code}.`,
          ),
        );
      }
    });
    this.worker = worker;
    worker.unref();
    return worker;
  }

  private failWorker(worker: Worker, error: WorkspaceAccessError): void {
    if (this.worker === worker) {
      this.worker = undefined;
    }
    void worker.terminate();
    this.failPending(error);
  }

  private failPending(error: WorkspaceAccessError): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.reject(error);
  }
}
