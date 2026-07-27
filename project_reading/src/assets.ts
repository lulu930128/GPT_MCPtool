import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";
import yauzl from "yauzl";
import type { ServerConfig } from "./config.js";
import {
  inspectOpenXmlPackage,
  readPowerPointPresentation,
  readWordDocument,
} from "./openxml.js";
import {
  WorkspaceAccessError,
  isWithinRoot,
  resolveWorkspacePath,
  toWorkspaceRelative,
} from "./path-guard.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const INSPECTABLE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ".xlsx",
  ".docx",
  ".pptx",
]);

export interface AssetArgs {
  scope: string;
  path: string;
}

export interface ReadImageArgs extends AssetArgs {
  maxDimension?: number;
}

export interface ReadSpreadsheetArgs extends AssetArgs {
  sheet?: string;
  range?: string;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
}

export interface ReadDocumentArgs extends AssetArgs {
  startBlock?: number;
  maxBlocks?: number;
  maxChars?: number;
}

export interface ReadPresentationArgs extends AssetArgs {
  startSlide?: number;
  maxSlides?: number;
  maxChars?: number;
  includeNotes?: boolean;
}

export interface ImageAssetResult {
  metadata: Record<string, unknown>;
  data: string;
  mimeType: "image/jpeg" | "image/png";
}

interface ResolvedAsset {
  scopeId: string;
  rootId: string;
  scopePath: string;
  absolute: string;
  relative: string;
  bytes: number;
  extension: string;
}

interface ZipInspection {
  entries: number;
  expandedBytes: number;
  externalLinksPresent: boolean;
}

export async function inspectAsset(config: ServerConfig, args: AssetArgs): Promise<unknown> {
  const asset = await resolveAsset(config, args);
  if (!INSPECTABLE_EXTENSIONS.has(asset.extension)) {
    throw new WorkspaceAccessError(
      `Unsupported asset type: ${asset.extension || "(no extension)"}.`,
    );
  }

  const base = {
    scope: asset.scopeId,
    path: asset.relative,
    bytes: asset.bytes,
    extension: asset.extension,
  };

  if (IMAGE_EXTENSIONS.has(asset.extension)) {
    assertFileSize(asset.bytes, config.maxImageFileBytes, "Image");
    const metadata = await readSharpMetadata(config, await fs.readFile(asset.absolute));
    return {
      ...base,
      kind: "image",
      readableBy: "read_image",
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      pages: metadata.pages ?? 1,
      hasAlpha: metadata.hasAlpha ?? false,
      orientation: metadata.orientation,
    };
  }

  if (asset.extension === ".xlsx") {
    assertFileSize(asset.bytes, config.maxSpreadsheetFileBytes, "Spreadsheet");
    const zip = await inspectSpreadsheetZip(config, asset.absolute);
    return {
      ...base,
      kind: "spreadsheet",
      readableBy: "read_spreadsheet",
      ...zip,
    };
  }

  assertFileSize(asset.bytes, config.maxOfficeFileBytes, "Office document");
  const kind = asset.extension === ".docx" ? "docx" : "pptx";
  const inspection = await inspectOpenXmlPackage(config, asset.absolute, kind);
  return {
    ...base,
    kind: kind === "docx" ? "word_document" : "presentation",
    readableBy: kind === "docx" ? "read_document" : "read_presentation",
    ...inspection,
  };
}

export async function readImageAsset(
  config: ServerConfig,
  args: ReadImageArgs,
): Promise<ImageAssetResult> {
  const asset = await resolveAsset(config, args);
  if (!IMAGE_EXTENSIONS.has(asset.extension)) {
    throw new WorkspaceAccessError("read_image supports JPEG, PNG, WebP, and GIF files only.");
  }
  assertFileSize(asset.bytes, config.maxImageFileBytes, "Image");

  const source = await fs.readFile(asset.absolute);
  const metadata = await readSharpMetadata(config, source);
  if (!metadata.width || !metadata.height) {
    throw new WorkspaceAccessError("Image dimensions could not be determined.");
  }

  const requestedMaxDimension = clampInt(
    args.maxDimension ?? config.maxImageDimension,
    1,
    config.maxImageDimension,
  );
  let dimension = Math.min(requestedMaxDimension, Math.max(metadata.width, metadata.height));
  const usePng = metadata.hasAlpha || metadata.format === "gif";
  let encoded:
    | { data: Buffer; info: sharp.OutputInfo; mimeType: "image/jpeg" | "image/png" }
    | undefined;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const pipeline = sharp(source, sharpInputOptions(config))
      .rotate()
      .resize({
        width: dimension,
        height: dimension,
        fit: "inside",
        withoutEnlargement: true,
      });
    const output = usePng
      ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
      : pipeline.jpeg({ quality: Math.max(60, 86 - attempt * 4), mozjpeg: true });
    const result = await output.toBuffer({ resolveWithObject: true });
    encoded = {
      data: result.data,
      info: result.info,
      mimeType: usePng ? "image/png" : "image/jpeg",
    };
    if (encoded.data.length <= config.maxImageOutputBytes) {
      break;
    }
    dimension = Math.max(256, Math.floor(dimension * 0.75));
  }

  if (!encoded || encoded.data.length > config.maxImageOutputBytes) {
    throw new WorkspaceAccessError(
      `Encoded image exceeds the output limit of ${config.maxImageOutputBytes} bytes.`,
    );
  }

  return {
    metadata: {
      ok: true,
      scope: asset.scopeId,
      path: asset.relative,
      sourceBytes: asset.bytes,
      sourceFormat: metadata.format,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourcePages: metadata.pages ?? 1,
      outputBytes: encoded.data.length,
      outputWidth: encoded.info.width,
      outputHeight: encoded.info.height,
      mimeType: encoded.mimeType,
      metadataStripped: true,
      animationDiscarded: (metadata.pages ?? 1) > 1,
    },
    data: encoded.data.toString("base64"),
    mimeType: encoded.mimeType,
  };
}

export async function readDocumentAsset(
  config: ServerConfig,
  args: ReadDocumentArgs,
): Promise<unknown> {
  const asset = await resolveAsset(config, args);
  if (asset.extension !== ".docx") {
    throw new WorkspaceAccessError("read_document supports .docx files only.");
  }
  assertFileSize(asset.bytes, config.maxOfficeFileBytes, "Word document");
  const result = await readWordDocument(config, asset.absolute, args);
  return {
    ok: true,
    scope: asset.scopeId,
    path: asset.relative,
    bytes: asset.bytes,
    ...(result as object),
  };
}

export async function readPresentationAsset(
  config: ServerConfig,
  args: ReadPresentationArgs,
): Promise<unknown> {
  const asset = await resolveAsset(config, args);
  if (asset.extension !== ".pptx") {
    throw new WorkspaceAccessError("read_presentation supports .pptx files only.");
  }
  assertFileSize(asset.bytes, config.maxOfficeFileBytes, "PowerPoint presentation");
  const result = await readPowerPointPresentation(config, asset.absolute, args);
  return {
    ok: true,
    scope: asset.scopeId,
    path: asset.relative,
    bytes: asset.bytes,
    ...(result as object),
  };
}

export async function readSpreadsheetAsset(
  config: ServerConfig,
  args: ReadSpreadsheetArgs,
): Promise<unknown> {
  const asset = await resolveAsset(config, args);
  if (asset.extension !== ".xlsx") {
    throw new WorkspaceAccessError("read_spreadsheet supports .xlsx files only.");
  }
  assertFileSize(asset.bytes, config.maxSpreadsheetFileBytes, "Spreadsheet");
  const zip = await inspectSpreadsheetZip(config, asset.absolute);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(asset.absolute);
  const worksheets = workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    rows: worksheet.actualRowCount,
    columns: worksheet.actualColumnCount,
  }));
  if (worksheets.length === 0) {
    throw new WorkspaceAccessError("Spreadsheet has no worksheets.");
  }

  const worksheet = args.sheet
    ? workbook.getWorksheet(args.sheet)
    : workbook.worksheets[0];
  if (!worksheet) {
    throw new WorkspaceAccessError(
      `Unknown worksheet: ${args.sheet}. Available sheets: ${worksheets
        .map((item) => item.name)
        .join(", ")}`,
    );
  }

  const requested = parseRange(args.range, worksheet.actualRowCount, worksheet.actualColumnCount);
  const maxRows = clampInt(
    args.maxRows ?? config.maxSpreadsheetRows,
    1,
    config.maxSpreadsheetRows,
  );
  const maxColumns = clampInt(
    args.maxColumns ?? config.maxSpreadsheetColumns,
    1,
    config.maxSpreadsheetColumns,
  );
  const maxCells = clampInt(
    args.maxCells ?? config.maxSpreadsheetCells,
    1,
    config.maxSpreadsheetCells,
  );
  const endRow = Math.min(requested.endRow, requested.startRow + maxRows - 1);
  const columnsByCellLimit = Math.max(1, Math.floor(maxCells / Math.max(1, endRow - requested.startRow + 1)));
  const endColumn = Math.min(
    requested.endColumn,
    requested.startColumn + maxColumns - 1,
    requested.startColumn + columnsByCellLimit - 1,
  );

  const rows: unknown[][] = [];
  let formulas = 0;
  let hyperlinksSuppressed = 0;
  for (let rowNumber = requested.startRow; rowNumber <= endRow; rowNumber += 1) {
    const row: unknown[] = [];
    for (
      let columnNumber = requested.startColumn;
      columnNumber <= endColumn;
      columnNumber += 1
    ) {
      const cell = worksheet.getCell(rowNumber, columnNumber);
      if (cell.type === ExcelJS.ValueType.Formula) {
        formulas += 1;
      }
      if (isSuppressedHyperlinkValue(cell.value)) {
        hyperlinksSuppressed += 1;
      }
      row.push(normalizeExcelValue(cell.value));
    }
    rows.push(row);
  }

  const returnedRange = formatRange(requested.startRow, requested.startColumn, endRow, endColumn);
  return {
    ok: true,
    scope: asset.scopeId,
    path: asset.relative,
    bytes: asset.bytes,
    sheet: worksheet.name,
    sheets: worksheets,
    requestedRange: args.range ?? null,
    returnedRange,
    rows,
    rowCount: rows.length,
    columnCount: rows[0]?.length ?? 0,
    cellCount: rows.length * (rows[0]?.length ?? 0),
    truncated:
      endRow < requested.endRow ||
      endColumn < requested.endColumn,
    formulas,
    hyperlinksSuppressed,
    externalLinksPresent: zip.externalLinksPresent,
    warnings: [
      ...(hyperlinksSuppressed > 0
        ? ["Hyperlink targets were not returned."]
        : []),
      ...(zip.externalLinksPresent
        ? ["The workbook contains external-link parts; no external resources were fetched."]
        : []),
    ],
  };
}

async function resolveAsset(config: ServerConfig, args: AssetArgs): Promise<ResolvedAsset> {
  const scopeId = args.scope.trim();
  const scope = config.assetScopes.get(scopeId);
  if (!scope) {
    throw new WorkspaceAccessError(
      `Unknown asset scope: ${scopeId}. Allowed scopes: ${
        Array.from(config.assetScopes.keys()).join(", ") || "(none configured)"
      }`,
    );
  }
  const assetPath = args.path.trim();
  if (!assetPath || assetPath.includes("\0") || path.isAbsolute(assetPath) || /^[a-z]:/i.test(assetPath)) {
    throw new WorkspaceAccessError("Asset path must be a non-empty relative path.");
  }

  const scopeBase = await resolveWorkspacePath(config, scope.path, "directory", scope.rootId);
  const rootRelativeAssetPath = path.join(scope.path, assetPath);
  const resolved = await resolveWorkspacePath(config, rootRelativeAssetPath, "file", scope.rootId);
  if (!isWithinRoot(scopeBase.absolute, resolved.absolute)) {
    throw new WorkspaceAccessError("Asset path escapes the configured asset scope.");
  }

  return {
    scopeId,
    rootId: scope.rootId,
    scopePath: scopeBase.relative,
    absolute: resolved.absolute,
    relative: toWorkspaceRelative(scopeBase.absolute, resolved.absolute),
    bytes: resolved.stat.size,
    extension: path.extname(resolved.absolute).toLowerCase(),
  };
}

async function readSharpMetadata(config: ServerConfig, source: Buffer): Promise<sharp.Metadata> {
  try {
    const metadata = await sharp(source, sharpInputOptions(config)).metadata();
    if (!metadata.format || !["jpeg", "png", "webp", "gif"].includes(metadata.format)) {
      throw new WorkspaceAccessError(`Unsupported or mismatched image format: ${metadata.format ?? "unknown"}.`);
    }
    return metadata;
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      throw error;
    }
    throw new WorkspaceAccessError(
      `Image could not be decoded safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sharpInputOptions(config: ServerConfig): sharp.SharpOptions {
  return {
    failOn: "warning",
    limitInputPixels: config.maxImagePixels,
    sequentialRead: true,
    unlimited: false,
  };
}

function inspectSpreadsheetZip(config: ServerConfig, filePath: string): Promise<ZipInspection> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
      },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(
            new WorkspaceAccessError(
              `Spreadsheet container is invalid: ${openError?.message ?? "could not open ZIP"}`,
            ),
          );
          return;
        }

        let entries = 0;
        let expandedBytes = 0;
        let externalLinksPresent = false;
        let hasContentTypes = false;
        let hasWorkbook = false;
        let settled = false;

        const fail = (message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          zipFile.close();
          reject(new WorkspaceAccessError(message));
        };

        zipFile.on("error", (error) => fail(`Spreadsheet ZIP error: ${error.message}`));
        zipFile.on("entry", (entry) => {
          entries += 1;
          expandedBytes += entry.uncompressedSize;
          const name = entry.fileName.replaceAll("\\", "/");
          const lower = name.toLowerCase();

          if (
            name.startsWith("/") ||
            /^[a-z]:/i.test(name) ||
            name.split("/").includes("..")
          ) {
            fail(`Spreadsheet contains an unsafe ZIP path: ${name}`);
            return;
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            fail("Encrypted spreadsheets are not supported.");
            return;
          }
          if (
            lower.includes("vbaproject") ||
            lower.startsWith("xl/activex/") ||
            lower.startsWith("xl/embeddings/")
          ) {
            fail("Spreadsheet contains macros, ActiveX, or embedded objects.");
            return;
          }
          if (entries > config.maxSpreadsheetZipEntries) {
            fail(`Spreadsheet exceeds the ZIP entry limit of ${config.maxSpreadsheetZipEntries}.`);
            return;
          }
          if (expandedBytes > config.maxSpreadsheetExpandedBytes) {
            fail(
              `Spreadsheet exceeds the expanded-size limit of ${config.maxSpreadsheetExpandedBytes} bytes.`,
            );
            return;
          }

          hasContentTypes ||= lower === "[content_types].xml";
          hasWorkbook ||= lower === "xl/workbook.xml";
          externalLinksPresent ||= lower.startsWith("xl/externallinks/");
          zipFile.readEntry();
        });
        zipFile.on("end", () => {
          if (settled) {
            return;
          }
          if (!hasContentTypes || !hasWorkbook) {
            fail("File is not a valid .xlsx workbook.");
            return;
          }
          settled = true;
          resolve({ entries, expandedBytes, externalLinksPresent });
        });
        zipFile.readEntry();
      },
    );
  });
}

function parseRange(
  value: string | undefined,
  actualRows: number,
  actualColumns: number,
): { startRow: number; startColumn: number; endRow: number; endColumn: number } {
  const fallbackEndRow = Math.max(1, actualRows);
  const fallbackEndColumn = Math.max(1, actualColumns);
  if (!value?.trim()) {
    return {
      startRow: 1,
      startColumn: 1,
      endRow: fallbackEndRow,
      endColumn: fallbackEndColumn,
    };
  }

  const match = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/i.exec(value.trim());
  if (!match) {
    throw new WorkspaceAccessError("Spreadsheet range must use A1 or A1:C20 notation.");
  }
  const startColumn = lettersToColumn(match[1]);
  const startRow = Number.parseInt(match[2], 10);
  const endColumn = match[3] ? lettersToColumn(match[3]) : startColumn;
  const endRow = match[4] ? Number.parseInt(match[4], 10) : startRow;
  if (endRow < startRow || endColumn < startColumn) {
    throw new WorkspaceAccessError("Spreadsheet range end must not precede its start.");
  }
  return { startRow, startColumn, endRow, endColumn };
}

function lettersToColumn(value: string): number {
  let result = 0;
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function columnToLetters(value: number): string {
  let current = value;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function formatRange(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): string {
  return `${columnToLetters(startColumn)}${startRow}:${columnToLetters(endColumn)}${endRow}`;
}

function normalizeExcelValue(value: ExcelJS.CellValue | undefined): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return value;
  }
  if ("formula" in value || "sharedFormula" in value) {
    const formula = "formula" in value ? value.formula : value.sharedFormula;
    if (/^\s*HYPERLINK\s*\(/i.test(formula ?? "")) {
      return {
        formula: "HYPERLINK(...)",
        result: normalizeExcelValue(value.result),
        hyperlinkPresent: true,
      };
    }
    return {
      formula,
      result: normalizeExcelValue(value.result),
    };
  }
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if ("hyperlink" in value) {
    return {
      text: value.text,
      hyperlinkPresent: true,
    };
  }
  if ("error" in value) {
    return { error: value.error };
  }
  return String(value);
}

function isSuppressedHyperlinkValue(value: ExcelJS.CellValue | undefined): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if ("hyperlink" in value) {
    return true;
  }
  if ("formula" in value || "sharedFormula" in value) {
    const formula = "formula" in value ? value.formula : value.sharedFormula;
    return /^\s*HYPERLINK\s*\(/i.test(formula ?? "");
  }
  return false;
}

function assertFileSize(actual: number, maximum: number, label: string): void {
  if (actual > maximum) {
    throw new WorkspaceAccessError(`${label} is too large (${actual} bytes > ${maximum} bytes).`);
  }
}

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
