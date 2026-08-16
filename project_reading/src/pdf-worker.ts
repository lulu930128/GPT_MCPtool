import { parentPort } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import {
  AnnotationType,
  getDocument,
  version as pdfjsVersion,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

interface PdfWorkerLimits {
  maxPages: number;
  maxReadPages: number;
  maxTextChars: number;
  maxRenderDimension: number;
  maxRenderPixels: number;
  maxOutputBytes: number;
}

interface PdfWorkerData {
  id: number;
  operation: "inspect" | "text" | "page";
  bytes: ArrayBuffer;
  args: Record<string, unknown>;
  limits: PdfWorkerLimits;
}

interface PdfSafety {
  encrypted: false;
  javascriptActions: false;
  openAction: false;
  embeddedFiles: false;
  activeAnnotations: false;
  externalTargetsFetched: false;
}

let input: PdfWorkerData;
let queue = Promise.resolve();
const port = parentPort;
if (!port) {
  throw new Error("PDF worker requires a parent message port.");
}

port.on("message", (job: PdfWorkerData) => {
  queue = queue.then(async () => {
    input = job;
    try {
      port.postMessage({ id: job.id, ok: true, result: await run() });
    } catch (error) {
      port.postMessage({ id: job.id, ok: false, error: normalizePdfError(error) });
    }
  });
});

async function run(): Promise<unknown> {
  const loadingTask = getDocument({
    data: new Uint8Array(input.bytes),
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  let document: PDFDocumentProxy | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages > input.limits.maxPages) {
      throw new Error(
        `PDF page count ${document.numPages} exceeds the limit of ${input.limits.maxPages}.`,
      );
    }

    const safety = await inspectSafety(document);
    if (input.operation === "inspect") {
      return await inspectDocument(document, safety);
    }
    if (input.operation === "text") {
      return await readText(document, safety);
    }
    return await renderPage(document, safety);
  } finally {
    if (document) {
      await document.destroy();
    } else {
      await loadingTask.destroy();
    }
  }
}

async function inspectSafety(document: PDFDocumentProxy): Promise<PdfSafety> {
  const [actions, hasActions, openAction, attachments] = await Promise.all([
    document.getJSActions(),
    document.hasJSActions(),
    document.getOpenAction(),
    document.getAttachments(),
  ]);
  if (hasActions || (actions && Object.keys(actions).length > 0)) {
    throw new Error("PDF contains JavaScript actions and was rejected.");
  }
  if (openAction) {
    throw new Error("PDF contains an automatic open action and was rejected.");
  }
  if (attachments && Object.keys(attachments).length > 0) {
    throw new Error("PDF contains embedded files and was rejected.");
  }
  const activeAnnotationTypes = new Set([
    AnnotationType.FILEATTACHMENT,
    AnnotationType.SOUND,
    AnnotationType.MOVIE,
    AnnotationType.SCREEN,
    AnnotationType.THREED,
  ]);
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    try {
      const annotations = await page.getAnnotations({ intent: "display" });
      if (
        annotations.some(
          (annotation) =>
            activeAnnotationTypes.has(annotation.annotationType) ||
            annotation.hasJSActions === true,
        )
      ) {
        throw new Error("PDF contains an active or embedded annotation and was rejected.");
      }
    } finally {
      page.cleanup();
    }
  }
  return {
    encrypted: false,
    javascriptActions: false,
    openAction: false,
    embeddedFiles: false,
    activeAnnotations: false,
    externalTargetsFetched: false,
  };
}

async function inspectDocument(
  document: PDFDocumentProxy,
  safety: PdfSafety,
): Promise<unknown> {
  const metadata = await document.getMetadata();
  const info = metadata.info as Record<string, unknown>;
  return {
    pageCount: document.numPages,
    pdfjsVersion,
    pdfVersion: safeMetadataString(info.PDFFormatVersion),
    metadata: {
      title: safeMetadataString(info.Title),
      author: safeMetadataString(info.Author),
      subject: safeMetadataString(info.Subject),
      keywords: safeMetadataString(info.Keywords),
      creator: safeMetadataString(info.Creator),
      producer: safeMetadataString(info.Producer),
      creationDate: safeMetadataString(info.CreationDate),
      modificationDate: safeMetadataString(info.ModDate),
    },
    safety,
  };
}

async function readText(document: PDFDocumentProxy, safety: PdfSafety): Promise<unknown> {
  const pageStart = clampInt(input.args.pageStart, 1, document.numPages, 1);
  const requestedPageCount = clampInt(
    input.args.pageCount,
    1,
    input.limits.maxReadPages,
    input.limits.maxReadPages,
  );
  const maxChars = clampInt(
    input.args.maxChars,
    1,
    input.limits.maxTextChars,
    input.limits.maxTextChars,
  );
  const pageEnd = Math.min(document.numPages, pageStart + requestedPageCount - 1);
  const pages: Array<{ page: number; text: string; truncated: boolean }> = [];
  let returnedChars = 0;
  let truncated = false;

  for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
    if (returnedChars >= maxChars) {
      truncated = true;
      break;
    }
    const page = await document.getPage(pageNumber);
    try {
      const content = await page.getTextContent({ disableNormalization: false });
      const rawText = content.items
        .map((item) => {
          if (!("str" in item)) {
            return "";
          }
          return `${item.str}${item.hasEOL ? "\n" : " "}`;
        })
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      const remaining = maxChars - returnedChars;
      const text = rawText.slice(0, remaining);
      const pageTruncated = text.length < rawText.length;
      pages.push({ page: pageNumber, text, truncated: pageTruncated });
      returnedChars += text.length;
      if (pageTruncated) {
        truncated = true;
        break;
      }
    } finally {
      page.cleanup();
    }
  }

  return {
    pageCount: document.numPages,
    pageStart,
    requestedPageCount,
    returnedPageCount: pages.length,
    returnedChars,
    pages,
    truncated,
    eof: pageEnd >= document.numPages,
    safety,
  };
}

async function renderPage(document: PDFDocumentProxy, safety: PdfSafety): Promise<unknown> {
  const pageNumber = clampInt(input.args.page, 1, document.numPages, 1);
  const maxDimension = clampInt(
    input.args.maxDimension,
    1,
    input.limits.maxRenderDimension,
    input.limits.maxRenderDimension,
  );
  const page = await document.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const dimensionScale = Math.min(
      maxDimension / baseViewport.width,
      maxDimension / baseViewport.height,
    );
    const pixelScale = Math.sqrt(
      input.limits.maxRenderPixels / (baseViewport.width * baseViewport.height),
    );
    let scale = Math.min(dimensionScale, pixelScale, 4);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error("PDF page dimensions are invalid.");
    }

    let output: Buffer | undefined;
    let outputWidth = 0;
    let outputHeight = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const viewport = page.getViewport({ scale });
      outputWidth = Math.max(1, Math.ceil(viewport.width));
      outputHeight = Math.max(1, Math.ceil(viewport.height));
      if (outputWidth * outputHeight > input.limits.maxRenderPixels) {
        throw new Error("Rendered PDF page would exceed the pixel limit.");
      }
      const canvas = createCanvas(outputWidth, outputHeight);
      const context = canvas.getContext("2d");
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
      } as unknown as Parameters<PDFPageProxy["render"]>[0]).promise;
      output = await canvas.encode("png");
      if (output.length <= input.limits.maxOutputBytes) {
        break;
      }
      scale *= 0.72;
    }

    if (!output || output.length > input.limits.maxOutputBytes) {
      throw new Error(
        `Rendered PDF page exceeds the output limit of ${input.limits.maxOutputBytes} bytes.`,
      );
    }
    return {
      page: pageNumber,
      pageCount: document.numPages,
      width: outputWidth,
      height: outputHeight,
      outputBytes: output.length,
      mimeType: "image/png",
      data: output.toString("base64"),
      metadataStripped: true,
      safety,
    };
  } finally {
    page.cleanup();
  }
}

function clampInt(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function safeMetadataString(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 500) : null;
}

function normalizePdfError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypted/i.test(message)) {
    return "Encrypted or password-protected PDF files are denied.";
  }
  return message.slice(0, 1_000);
}
