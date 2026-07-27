import path from "node:path";
import { SaxesParser, type SaxesTagNS } from "saxes";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ServerConfig } from "./config.js";
import { WorkspaceAccessError } from "./path-guard.js";

export type OpenXmlKind = "docx" | "pptx";

export interface ReadDocumentOptions {
  startBlock?: number;
  maxBlocks?: number;
  maxChars?: number;
}

export interface ReadPresentationOptions {
  startSlide?: number;
  maxSlides?: number;
  maxChars?: number;
  includeNotes?: boolean;
}

export interface OpenXmlInspection {
  entries: number;
  expandedBytes: number;
  capturedXmlBytes: number;
  externalRelationships: number;
  slideCount?: number;
}

interface OfficePackage {
  parts: Map<string, string>;
  partNames: string[];
  entries: number;
  expandedBytes: number;
  capturedXmlBytes: number;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface ParagraphBlock {
  type: "paragraph";
  text: string;
  style?: string;
  headingLevel?: number;
  textTruncated?: boolean;
}

interface TableBlock {
  type: "table";
  rows: string[][];
  rowCount: number;
  columnCount: number;
  textTruncated?: boolean;
}

type DocumentBlock = ParagraphBlock | TableBlock;

interface ParsedDocument {
  blocks: DocumentBlock[];
  paragraphs: number;
  tables: number;
  tableCells: number;
  insertions: number;
  deletions: number;
  hyperlinks: number;
}

interface ParsedSlide {
  title: string | null;
  texts: string[];
}

const MAX_PARSED_DOCUMENT_BLOCKS = 20_000;

export async function inspectOpenXmlPackage(
  config: ServerConfig,
  filePath: string,
  kind: OpenXmlKind,
): Promise<OpenXmlInspection> {
  const officePackage = await readOfficePackage(
    config,
    filePath,
    kind,
    (name) => name.endsWith(".rels"),
  );
  return {
    entries: officePackage.entries,
    expandedBytes: officePackage.expandedBytes,
    capturedXmlBytes: officePackage.capturedXmlBytes,
    externalRelationships: countExternalRelationships(officePackage.parts),
    ...(kind === "pptx"
      ? {
          slideCount: officePackage.partNames.filter((name) =>
            /^ppt\/slides\/slide\d+\.xml$/i.test(name),
          ).length,
        }
      : {}),
  };
}

export async function readWordDocument(
  config: ServerConfig,
  filePath: string,
  options: ReadDocumentOptions,
): Promise<unknown> {
  const officePackage = await readOfficePackage(
    config,
    filePath,
    "docx",
    (name) => name === "word/document.xml" || name.endsWith(".rels"),
  );
  const documentXml = officePackage.parts.get("word/document.xml");
  if (!documentXml) {
    throw new WorkspaceAccessError("DOCX is missing word/document.xml.");
  }

  const parsed = parseWordDocument(documentXml, config.maxDocumentTableCells);
  const startBlock = clampInt(options.startBlock ?? 1, 1, Math.max(parsed.blocks.length + 1, 1));
  const maxBlocks = clampInt(
    options.maxBlocks ?? config.maxDocumentBlocks,
    1,
    config.maxDocumentBlocks,
  );
  const maxChars = clampInt(
    options.maxChars ?? config.maxOfficeTextChars,
    1,
    config.maxOfficeTextChars,
  );
  const selected = selectDocumentBlocks(parsed.blocks, startBlock, maxBlocks, maxChars);
  const externalRelationships = countExternalRelationships(officePackage.parts);

  return {
    blocks: selected.blocks,
    startBlock,
    returnedBlocks: selected.blocks.length,
    totalBlocks: parsed.blocks.length,
    nextStartBlock:
      selected.nextStartBlock <= parsed.blocks.length ? selected.nextStartBlock : null,
    truncated: selected.truncated,
    textChars: selected.textChars,
    summary: {
      paragraphs: parsed.paragraphs,
      tables: parsed.tables,
      tableCells: parsed.tableCells,
      trackedInsertions: parsed.insertions,
      trackedDeletionsExcluded: parsed.deletions,
      hyperlinks: parsed.hyperlinks,
      externalRelationshipsSuppressed: externalRelationships,
    },
    warnings: [
      "This is structural OOXML extraction, not a page-layout render.",
      "Headers, footers, comments, footnotes, endnotes, images, and embedded objects are not returned.",
      ...(parsed.deletions > 0
        ? ["Tracked deletion text was excluded; inserted text was included."]
        : []),
      ...(externalRelationships > 0
        ? ["External relationship targets were not returned or fetched."]
        : []),
    ],
  };
}

export async function readPowerPointPresentation(
  config: ServerConfig,
  filePath: string,
  options: ReadPresentationOptions,
): Promise<unknown> {
  const officePackage = await readOfficePackage(
    config,
    filePath,
    "pptx",
    (name) =>
      name === "ppt/presentation.xml" ||
      name.endsWith(".rels") ||
      /^ppt\/slides\/slide\d+\.xml$/i.test(name) ||
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name),
  );
  const presentationXml = officePackage.parts.get("ppt/presentation.xml");
  const presentationRelsXml = officePackage.parts.get("ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !presentationRelsXml) {
    throw new WorkspaceAccessError("PPTX is missing its presentation manifest or relationships.");
  }

  const orderedSlideParts = resolveSlideOrder(presentationXml, presentationRelsXml);
  if (orderedSlideParts.length === 0) {
    throw new WorkspaceAccessError("Presentation has no slides.");
  }

  const startSlide = clampInt(
    options.startSlide ?? 1,
    1,
    orderedSlideParts.length + 1,
  );
  const maxSlides = clampInt(
    options.maxSlides ?? config.maxPresentationSlides,
    1,
    config.maxPresentationSlides,
  );
  const maxChars = clampInt(
    options.maxChars ?? config.maxOfficeTextChars,
    1,
    config.maxOfficeTextChars,
  );
  const includeNotes = options.includeNotes ?? false;
  const slides: Array<{
    number: number;
    title: string | null;
    texts: string[];
    notes?: string[];
    textTruncated?: boolean;
  }> = [];
  let textChars = 0;
  let truncatedByChars = false;

  for (
    let index = startSlide - 1;
    index < orderedSlideParts.length && slides.length < maxSlides;
    index += 1
  ) {
    const slidePart = orderedSlideParts[index];
    const slideXml = officePackage.parts.get(slidePart);
    if (!slideXml) {
      throw new WorkspaceAccessError(`PPTX is missing slide part: ${slidePart}`);
    }
    const parsedSlide = parsePresentationText(slideXml, false);
    const notes = includeNotes
      ? findAndParseSpeakerNotes(officePackage.parts, slidePart)
      : undefined;
    const remainingChars = maxChars - textChars;
    const limited = limitSlideText(parsedSlide, notes, remainingChars);
    if (limited.texts.length === 0 && (limited.notes?.length ?? 0) === 0 && remainingChars <= 0) {
      truncatedByChars = true;
      break;
    }
    slides.push({
      number: index + 1,
      title: limited.title,
      texts: limited.texts,
      ...(includeNotes ? { notes: limited.notes ?? [] } : {}),
      ...(limited.truncated ? { textTruncated: true } : {}),
    });
    textChars += limited.textChars;
    if (limited.truncated) {
      truncatedByChars = true;
      break;
    }
  }

  const lastReturnedSlide = slides.at(-1)?.number ?? startSlide - 1;
  const hasMoreSlides = lastReturnedSlide < orderedSlideParts.length;
  const externalRelationships = countExternalRelationships(officePackage.parts);
  return {
    slides,
    startSlide,
    returnedSlides: slides.length,
    totalSlides: orderedSlideParts.length,
    nextStartSlide: hasMoreSlides ? lastReturnedSlide + 1 : null,
    truncated: hasMoreSlides || truncatedByChars,
    textChars,
    includeNotes,
    summary: {
      slidesWithTitles: slides.filter((slide) => slide.title).length,
      externalRelationshipsSuppressed: externalRelationships,
    },
    warnings: [
      "Text order follows OOXML shape order and may differ from visual reading order.",
      "Images, charts, SmartArt geometry, animations, transitions, comments, and embedded objects are not returned.",
      ...(includeNotes
        ? ["Speaker notes were included only where an internal notes-slide relationship exists."]
        : ["Speaker notes were omitted unless includeNotes=true is requested."]),
      ...(externalRelationships > 0
        ? ["External relationship targets were not returned or fetched."]
        : []),
    ],
  };
}

async function readOfficePackage(
  config: ServerConfig,
  filePath: string,
  kind: OpenXmlKind,
  capturePart: (normalizedName: string) => boolean,
): Promise<OfficePackage> {
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
              `Office document container is invalid: ${openError?.message ?? "could not open ZIP"}`,
            ),
          );
          return;
        }

        const parts = new Map<string, string>();
        const partNames: string[] = [];
        let entries = 0;
        let expandedBytes = 0;
        let capturedXmlBytes = 0;
        let hasContentTypes = false;
        let hasMainPart = false;
        let settled = false;

        const fail = (message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          try {
            zipFile.close();
          } catch {
            // The ZIP may already be auto-closed after the final entry.
          }
          reject(new WorkspaceAccessError(message));
        };

        zipFile.on("error", (error) => fail(`Office ZIP error: ${error.message}`));
        zipFile.on("entry", (entry) => {
          void (async () => {
            entries += 1;
            expandedBytes += entry.uncompressedSize;
            const name = normalizeZipEntryName(entry.fileName);
            const lower = name.toLowerCase();
            partNames.push(name);

            if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new WorkspaceAccessError("Encrypted Office documents are not supported.");
            }
            if (
              lower.includes("vbaproject") ||
              lower.includes("/activex/") ||
              lower.includes("/embeddings/") ||
              lower.includes("/oleobjects/")
            ) {
              throw new WorkspaceAccessError(
                "Office document contains macros, ActiveX, OLE, or embedded objects.",
              );
            }
            if (entries > config.maxOfficeZipEntries) {
              throw new WorkspaceAccessError(
                `Office document exceeds the ZIP entry limit of ${config.maxOfficeZipEntries}.`,
              );
            }
            if (expandedBytes > config.maxOfficeExpandedBytes) {
              throw new WorkspaceAccessError(
                `Office document exceeds the expanded-size limit of ${config.maxOfficeExpandedBytes} bytes.`,
              );
            }

            hasContentTypes ||= lower === "[content_types].xml";
            hasMainPart ||= lower === (kind === "docx" ? "word/document.xml" : "ppt/presentation.xml");
            if (capturePart(name)) {
              if (entry.uncompressedSize > config.maxOfficeXmlPartBytes) {
                throw new WorkspaceAccessError(
                  `Office XML part exceeds ${config.maxOfficeXmlPartBytes} bytes: ${name}`,
                );
              }
              capturedXmlBytes += entry.uncompressedSize;
              if (capturedXmlBytes > config.maxOfficeXmlTotalBytes) {
                throw new WorkspaceAccessError(
                  `Office XML exceeds the total capture limit of ${config.maxOfficeXmlTotalBytes} bytes.`,
                );
              }
              const buffer = await readZipEntry(zipFile, entry, config.maxOfficeXmlPartBytes);
              parts.set(name, buffer.toString("utf8"));
            }
            if (!settled) {
              zipFile.readEntry();
            }
          })().catch((error) =>
            fail(error instanceof Error ? error.message : String(error)),
          );
        });
        zipFile.on("end", () => {
          if (settled) {
            return;
          }
          if (!hasContentTypes || !hasMainPart) {
            fail(`File is not a valid ${kind.toUpperCase()} package.`);
            return;
          }
          settled = true;
          resolve({ parts, partNames, entries, expandedBytes, capturedXmlBytes });
        });
        zipFile.readEntry();
      },
    );
  });
}

function readZipEntry(zipFile: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("Could not open ZIP entry stream."));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumBytes) {
          stream.destroy(new Error(`ZIP entry exceeds ${maximumBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function normalizeZipEntryName(rawName: string): string {
  const name = rawName.replaceAll("\\", "/");
  if (
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    name.split("/").includes("..") ||
    name.includes("\0")
  ) {
    throw new WorkspaceAccessError(`Office document contains an unsafe ZIP path: ${name}`);
  }
  return path.posix.normalize(name);
}

function parseWordDocument(xml: string, maxTableCells: number): ParsedDocument {
  const blocks: DocumentBlock[] = [];
  let currentParagraph:
    | { parts: string[]; style?: string; inTable: boolean }
    | undefined;
  let currentTable: { rows: string[][] } | undefined;
  let currentRow: string[] | undefined;
  let currentCell: string[] | undefined;
  let nestedTableDepth = 0;
  let textDepth = 0;
  let deletedDepth = 0;
  let paragraphs = 0;
  let tables = 0;
  let tableCells = 0;
  let insertions = 0;
  let deletions = 0;
  let hyperlinks = 0;

  parseXml(xml, "word/document.xml", {
    open(tag) {
      const local = tag.local;
      if (local === "del") {
        deletedDepth += 1;
        deletions += 1;
      } else if (local === "ins") {
        insertions += 1;
      } else if (local === "hyperlink") {
        hyperlinks += 1;
      } else if (local === "tbl") {
        if (currentTable) {
          nestedTableDepth += 1;
        } else {
          currentTable = { rows: [] };
        }
      } else if (local === "tr" && currentTable && nestedTableDepth === 0) {
        currentRow = [];
      } else if (local === "tc" && currentTable && nestedTableDepth === 0) {
        currentCell = [];
      } else if (local === "p") {
        currentParagraph = {
          parts: [],
          inTable: Boolean(currentTable),
        };
      } else if (local === "pStyle" && currentParagraph) {
        currentParagraph.style = getAttribute(tag, "val");
      } else if (local === "t") {
        textDepth += 1;
      } else if ((local === "tab" || local === "br" || local === "cr") && currentParagraph && deletedDepth === 0) {
        currentParagraph.parts.push(local === "tab" ? "\t" : "\n");
      }
    },
    text(value) {
      if (textDepth > 0 && currentParagraph && deletedDepth === 0) {
        currentParagraph.parts.push(value);
      }
    },
    close(tag) {
      const local = tag.local;
      if (local === "t") {
        textDepth = Math.max(0, textDepth - 1);
      } else if (local === "del") {
        deletedDepth = Math.max(0, deletedDepth - 1);
      } else if (local === "p" && currentParagraph) {
        const text = normalizeExtractedText(currentParagraph.parts.join(""));
        if (currentParagraph.inTable && currentCell) {
          if (text) {
            currentCell.push(text);
          }
        } else if (text || currentParagraph.style) {
          const headingLevel = headingLevelFromStyle(currentParagraph.style);
          blocks.push({
            type: "paragraph",
            text,
            ...(currentParagraph.style ? { style: currentParagraph.style } : {}),
            ...(headingLevel ? { headingLevel } : {}),
          });
          paragraphs += 1;
          assertDocumentBlockLimit(blocks.length);
        }
        currentParagraph = undefined;
      } else if (local === "tc" && currentTable && nestedTableDepth === 0 && currentRow && currentCell) {
        currentRow.push(currentCell.join("\n"));
        tableCells += 1;
        if (tableCells > maxTableCells) {
          throw new WorkspaceAccessError(
            `Document exceeds the table-cell limit of ${maxTableCells}.`,
          );
        }
        currentCell = undefined;
      } else if (local === "tr" && currentTable && nestedTableDepth === 0 && currentRow) {
        currentTable.rows.push(currentRow);
        currentRow = undefined;
      } else if (local === "tbl" && currentTable) {
        if (nestedTableDepth > 0) {
          nestedTableDepth -= 1;
        } else {
          const columnCount = currentTable.rows.reduce(
            (maximum, row) => Math.max(maximum, row.length),
            0,
          );
          blocks.push({
            type: "table",
            rows: currentTable.rows,
            rowCount: currentTable.rows.length,
            columnCount,
          });
          tables += 1;
          assertDocumentBlockLimit(blocks.length);
          currentTable = undefined;
        }
      }
    },
  });

  return {
    blocks,
    paragraphs,
    tables,
    tableCells,
    insertions,
    deletions,
    hyperlinks,
  };
}

function parsePresentationText(xml: string, notesOnly: boolean): ParsedSlide {
  const texts: string[] = [];
  let title: string | null = null;
  let inShape = false;
  let placeholderType: string | undefined;
  let currentParagraph: { parts: string[]; placeholder?: string } | undefined;
  let textDepth = 0;

  parseXml(xml, notesOnly ? "speaker notes" : "slide", {
    open(tag) {
      if (tag.local === "sp") {
        inShape = true;
        placeholderType = undefined;
      } else if (tag.local === "ph" && inShape) {
        placeholderType = getAttribute(tag, "type") ?? "body";
      } else if (tag.local === "p") {
        currentParagraph = { parts: [], placeholder: placeholderType };
      } else if (tag.local === "t") {
        textDepth += 1;
      } else if ((tag.local === "br" || tag.local === "tab") && currentParagraph) {
        currentParagraph.parts.push(tag.local === "tab" ? "\t" : "\n");
      }
    },
    text(value) {
      if (textDepth > 0 && currentParagraph) {
        currentParagraph.parts.push(value);
      }
    },
    close(tag) {
      if (tag.local === "t") {
        textDepth = Math.max(0, textDepth - 1);
      } else if (tag.local === "p" && currentParagraph) {
        const text = normalizeExtractedText(currentParagraph.parts.join(""));
        const include =
          Boolean(text) &&
          (!notesOnly || currentParagraph.placeholder === "body");
        if (include) {
          texts.push(text);
          if (
            !notesOnly &&
            !title &&
            (currentParagraph.placeholder === "title" ||
              currentParagraph.placeholder === "ctrTitle")
          ) {
            title = text;
          }
        }
        currentParagraph = undefined;
      } else if (tag.local === "sp") {
        inShape = false;
        placeholderType = undefined;
      }
    },
  });

  return {
    title: title ?? (!notesOnly ? texts[0] ?? null : null),
    texts,
  };
}

function resolveSlideOrder(presentationXml: string, relationshipsXml: string): string[] {
  const relationshipMap = new Map(
    parseRelationships(relationshipsXml)
      .filter((relationship) => !relationship.external && /\/slide$/i.test(relationship.type))
      .map((relationship) => [relationship.id, relationship]),
  );
  const ids: string[] = [];
  parseXml(presentationXml, "ppt/presentation.xml", {
    open(tag) {
      if (tag.local === "sldId") {
        const relationshipId = getAttribute(tag, "id", "r");
        if (relationshipId) {
          ids.push(relationshipId);
        }
      }
    },
  });

  return ids.map((id) => {
    const relationship = relationshipMap.get(id);
    if (!relationship) {
      throw new WorkspaceAccessError(`Presentation slide relationship is missing: ${id}`);
    }
    return resolveInternalPart("ppt/presentation.xml", relationship.target);
  });
}

function findAndParseSpeakerNotes(
  parts: Map<string, string>,
  slidePart: string,
): string[] {
  const relsPart = relationshipPartPath(slidePart);
  const relsXml = parts.get(relsPart);
  if (!relsXml) {
    return [];
  }
  const notesRelationship = parseRelationships(relsXml).find(
    (relationship) => !relationship.external && /\/notesSlide$/i.test(relationship.type),
  );
  if (!notesRelationship) {
    return [];
  }
  const notesPart = resolveInternalPart(slidePart, notesRelationship.target);
  const notesXml = parts.get(notesPart);
  return notesXml ? parsePresentationText(notesXml, true).texts : [];
}

function parseRelationships(xml: string): Relationship[] {
  const relationships: Relationship[] = [];
  parseXml(xml, "relationships", {
    open(tag) {
      if (tag.local !== "Relationship") {
        return;
      }
      const id = getAttribute(tag, "Id") ?? "";
      const type = getAttribute(tag, "Type") ?? "";
      const target = getAttribute(tag, "Target") ?? "";
      const targetMode = getAttribute(tag, "TargetMode") ?? "";
      if (id && type && target) {
        relationships.push({
          id,
          type,
          target,
          external: targetMode.toLowerCase() === "external",
        });
      }
    },
  });
  return relationships;
}

function countExternalRelationships(parts: Map<string, string>): number {
  let count = 0;
  for (const [name, xml] of parts) {
    if (name.endsWith(".rels")) {
      count += parseRelationships(xml).filter((relationship) => relationship.external).length;
    }
  }
  return count;
}

function relationshipPartPath(partName: string): string {
  return path.posix.join(
    path.posix.dirname(partName),
    "_rels",
    `${path.posix.basename(partName)}.rels`,
  );
}

function resolveInternalPart(sourcePart: string, target: string): string {
  const normalizedTarget = target.replaceAll("\\", "/");
  if (
    normalizedTarget.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedTarget) ||
    normalizedTarget.includes("\0")
  ) {
    throw new WorkspaceAccessError("Office relationship target is not a safe internal path.");
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePart), normalizedTarget),
  );
  if (resolved.startsWith("../") || resolved === "..") {
    throw new WorkspaceAccessError("Office relationship target escapes the package.");
  }
  return resolved;
}

function parseXml(
  xml: string,
  label: string,
  handlers: {
    open?: (tag: SaxesTagNS) => void;
    text?: (value: string) => void;
    close?: (tag: SaxesTagNS) => void;
  },
): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new WorkspaceAccessError(`${label} contains a forbidden DTD or entity declaration.`);
  }

  const parser = new SaxesParser({ xmlns: true, position: false });
  let parseError: Error | undefined;
  parser.on("doctype", () => {
    parseError = new Error("DOCTYPE is forbidden.");
  });
  parser.on("opentag", (tag) => handlers.open?.(tag));
  parser.on("text", (value) => handlers.text?.(value));
  parser.on("closetag", (tag) => handlers.close?.(tag));
  parser.on("error", (error) => {
    parseError = error;
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    parseError = error instanceof Error ? error : new Error(String(error));
  }
  if (parseError) {
    throw new WorkspaceAccessError(`${label} contains invalid XML: ${parseError.message}`);
  }
}

function getAttribute(
  tag: SaxesTagNS,
  localName: string,
  prefix?: string,
): string | undefined {
  return Object.values(tag.attributes).find(
    (attribute) =>
      attribute.local.toLowerCase() === localName.toLowerCase() &&
      (prefix === undefined || attribute.prefix === prefix),
  )?.value;
}

function selectDocumentBlocks(
  blocks: DocumentBlock[],
  startBlock: number,
  maxBlocks: number,
  maxChars: number,
): {
  blocks: DocumentBlock[];
  nextStartBlock: number;
  truncated: boolean;
  textChars: number;
} {
  const selected: DocumentBlock[] = [];
  let textChars = 0;
  let index = startBlock - 1;
  let textTruncated = false;

  while (index < blocks.length && selected.length < maxBlocks && textChars < maxChars) {
    const limited = limitDocumentBlock(blocks[index], maxChars - textChars);
    if (!limited.block) {
      textTruncated = true;
      break;
    }
    selected.push(limited.block);
    textChars += limited.textChars;
    index += 1;
    if (limited.truncated) {
      textTruncated = true;
      break;
    }
  }

  return {
    blocks: selected,
    nextStartBlock: index + 1,
    truncated: textTruncated || index < blocks.length,
    textChars,
  };
}

function limitDocumentBlock(
  block: DocumentBlock,
  budget: number,
): { block?: DocumentBlock; textChars: number; truncated: boolean } {
  if (budget <= 0) {
    return { textChars: 0, truncated: true };
  }
  if (block.type === "paragraph") {
    const text = block.text.slice(0, budget);
    return {
      block: {
        ...block,
        text,
        ...(text.length < block.text.length ? { textTruncated: true } : {}),
      },
      textChars: text.length,
      truncated: text.length < block.text.length,
    };
  }

  const rows: string[][] = [];
  let used = 0;
  let truncated = false;
  for (const row of block.rows) {
    const limitedRow: string[] = [];
    for (const cell of row) {
      const separatorCost = used > 0 ? 1 : 0;
      const remaining = budget - used - separatorCost;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const value = cell.slice(0, remaining);
      limitedRow.push(value);
      used += separatorCost + value.length;
      if (value.length < cell.length) {
        truncated = true;
        break;
      }
    }
    if (limitedRow.length > 0) {
      rows.push(limitedRow);
    }
    if (truncated) {
      break;
    }
  }
  return {
    block: {
      ...block,
      rows,
      ...(truncated ? { textTruncated: true } : {}),
    },
    textChars: used,
    truncated,
  };
}

function limitSlideText(
  slide: ParsedSlide,
  notes: string[] | undefined,
  budget: number,
): {
  title: string | null;
  texts: string[];
  notes?: string[];
  textChars: number;
  truncated: boolean;
} {
  const texts: string[] = [];
  const selectedNotes: string[] = [];
  let used = 0;
  let truncated = false;

  const append = (source: string[], target: string[]) => {
    for (const value of source) {
      const separatorCost = used > 0 ? 1 : 0;
      const remaining = budget - used - separatorCost;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const limited = value.slice(0, remaining);
      target.push(limited);
      used += separatorCost + limited.length;
      if (limited.length < value.length) {
        truncated = true;
        return;
      }
    }
  };

  append(slide.texts, texts);
  if (!truncated && notes) {
    append(notes, selectedNotes);
  }
  const title =
    slide.title && texts.includes(slide.title)
      ? slide.title
      : slide.title?.slice(0, Math.max(0, budget)) || null;
  return {
    title,
    texts,
    ...(notes ? { notes: selectedNotes } : {}),
    textChars: used,
    truncated,
  };
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headingLevelFromStyle(style: string | undefined): number | undefined {
  const match = /(?:heading|標題)\s*([1-9])/i.exec(style ?? "");
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function assertDocumentBlockLimit(blocks: number): void {
  if (blocks > MAX_PARSED_DOCUMENT_BLOCKS) {
    throw new WorkspaceAccessError(
      `Document exceeds the parsed-block limit of ${MAX_PARSED_DOCUMENT_BLOCKS}.`,
    );
  }
}

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
