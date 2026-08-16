import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { loadConfig } from "../dist/src/config.js";
import { startWorkspaceHttpServer } from "../dist/src/http-server.js";
import { writeOfficeSmokeFixtures } from "./office-fixtures.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-mcp-asset-smoke-"));
const assets = path.join(root, "assets");
await fs.mkdir(assets);
await sharp({
  create: {
    width: 320,
    height: 160,
    channels: 3,
    background: "#336699",
  },
})
  .gif()
  .toFile(path.join(assets, "sample.gif"));

const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("Smoke");
worksheet.addRow(["name", "value"]);
worksheet.addRow(["ready", 1]);
await workbook.xlsx.writeFile(path.join(assets, "sample.xlsx"));
await writeOfficeSmokeFixtures(assets);
const pdf = await PDFDocument.create();
pdf.setTitle("Project Reading PDF smoke");
const pdfFont = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([360, 480]).drawText("Project Reading PDF ready", {
  x: 36,
  y: 400,
  size: 18,
  font: pdfFont,
});
await fs.writeFile(
  path.join(assets, "sample.pdf"),
  await pdf.save({ useObjectStreams: false }),
);

const config = await loadConfig({
  WORKSPACE_MCP_ROOTS: `smoke=${root}`,
  WORKSPACE_MCP_DEFAULT_ROOT: "smoke",
  WORKSPACE_MCP_ASSET_SCOPES: "media=smoke:assets",
  WORKSPACE_MCP_FILE_RETURN_SCOPES: "media",
});
const handle = await startWorkspaceHttpServer(config, {
  host: "127.0.0.1",
  port: 0,
});
let sessionId;
let nextId = 1;

try {
  async function rpc(method, params) {
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
    sessionId ||= response.headers.get("mcp-session-id") || undefined;
    const body = await response.text();
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .at(-1);
    const payload = JSON.parse(data || body);
    assert.equal(payload.error, undefined, JSON.stringify(payload.error));
    return payload.result;
  }

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "asset-smoke", version: "1.5.0" },
  });
  assert.equal(initialized.serverInfo.version, "1.5.0");
  const resourceTemplates = await rpc("resources/templates/list", {});
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "workspace-asset:///{scope}/{+path}",
    ),
    "Missing workspace asset resource template",
  );
  const listed = await rpc("tools/list", {});
  assert.equal(listed.tools.length, 24);
  for (const required of [
    "read_files",
    "find_files",
    "git_diff",
    "git_diff_file",
    "find_symbol",
    "find_references",
    "import_graph",
    "project_map",
    "fetch_asset",
    "inspect_pdf",
    "read_pdf_text",
    "read_pdf_page",
  ]) {
    assert.ok(listed.tools.some((tool) => tool.name === required), `Missing tool: ${required}`);
  }

  const image = await rpc("tools/call", {
    name: "read_image",
    arguments: { scope: "media", path: "sample.gif", maxDimension: 128 },
  });
  const imageContent = image.content.find((item) => item.type === "image");
  assert.equal(imageContent?.mimeType, "image/png");
  const decodedImage = Buffer.from(imageContent.data, "base64");
  const imageMetadata = await sharp(decodedImage).metadata();
  assert.equal(imageMetadata.width, 128);
  assert.equal(imageMetadata.height, 64);
  assert.equal(image.structuredContent.mimeType, "image/png");

  const fetched = await rpc("tools/call", {
    name: "fetch_asset",
    arguments: { scope: "media", path: "sample.gif" },
  });
  const fetchedResource = fetched.content.find((item) => item.type === "resource_link");
  const originalImage = await fs.readFile(path.join(assets, "sample.gif"));
  const readResource = await rpc("resources/read", { uri: fetchedResource.uri });
  const returnedResource = readResource.contents[0];
  const fetchedBytes = Buffer.from(returnedResource.blob, "base64");
  assert.deepEqual(fetchedBytes, originalImage);
  assert.equal(fetchedResource.mimeType, "image/gif");
  assert.equal(returnedResource.mimeType, "image/gif");
  assert.equal(fetched.structuredContent.bytes, originalImage.length);
  assert.equal(
    fetched.structuredContent.sha256,
    createHash("sha256").update(originalImage).digest("hex"),
  );
  assert.equal(fetched.structuredContent.transfer, "resource_link");

  const spreadsheet = await rpc("tools/call", {
    name: "read_spreadsheet",
    arguments: { scope: "media", path: "sample.xlsx", range: "A1:B2" },
  });
  const spreadsheetText = spreadsheet.content.find((item) => item.type === "text")?.text;
  const spreadsheetResult = JSON.parse(spreadsheetText);
  assert.deepEqual(spreadsheetResult.rows, [
    ["name", "value"],
    ["ready", 1],
  ]);

  const document = await rpc("tools/call", {
    name: "read_document",
    arguments: { scope: "media", path: "sample.docx" },
  });
  const documentResult = JSON.parse(
    document.content.find((item) => item.type === "text")?.text,
  );
  assert.equal(documentResult.blocks[0].text, "Smoke document");
  assert.equal(documentResult.summary.tables, 1);

  const presentation = await rpc("tools/call", {
    name: "read_presentation",
    arguments: { scope: "media", path: "sample.pptx" },
  });
  const presentationResult = JSON.parse(
    presentation.content.find((item) => item.type === "text")?.text,
  );
  assert.equal(presentationResult.slides[0].title, "Smoke presentation");
  assert.deepEqual(presentationResult.slides[0].texts, [
    "Smoke presentation",
    "PowerPoint extraction ready",
  ]);

  const pdfInspection = await rpc("tools/call", {
    name: "inspect_pdf",
    arguments: { scope: "media", path: "sample.pdf" },
  });
  assert.equal(pdfInspection.structuredContent.pageCount, 1);
  assert.equal(pdfInspection.structuredContent.metadata.title, "Project Reading PDF smoke");

  const pdfText = await rpc("tools/call", {
    name: "read_pdf_text",
    arguments: { scope: "media", path: "sample.pdf", pageCount: 1 },
  });
  assert.match(pdfText.structuredContent.pages[0].text, /Project Reading PDF ready/);

  const pdfPage = await rpc("tools/call", {
    name: "read_pdf_page",
    arguments: { scope: "media", path: "sample.pdf", page: 1, maxDimension: 256 },
  });
  const pdfImage = pdfPage.content.find((item) => item.type === "image");
  assert.equal(pdfImage?.mimeType, "image/png");
  const pdfImageMetadata = await sharp(Buffer.from(pdfImage.data, "base64")).metadata();
  assert.ok(pdfImageMetadata.width <= 256);
  assert.ok(pdfImageMetadata.height <= 256);

  console.log(
    JSON.stringify(
      {
        ok: true,
        serverVersion: initialized.serverInfo.version,
        toolCount: listed.tools.length,
        image: {
          mimeType: imageContent.mimeType,
          width: imageMetadata.width,
          height: imageMetadata.height,
          bytes: decodedImage.length,
        },
        fetch: {
          mimeType: fetchedResource.mimeType,
          bytes: fetchedBytes.length,
          sha256: fetched.structuredContent.sha256,
        },
        spreadsheet: {
          sheet: spreadsheetResult.sheet,
          range: spreadsheetResult.returnedRange,
          rows: spreadsheetResult.rowCount,
          columns: spreadsheetResult.columnCount,
        },
        document: {
          blocks: documentResult.returnedBlocks,
          tables: documentResult.summary.tables,
        },
        presentation: {
          slides: presentationResult.returnedSlides,
          title: presentationResult.slides[0].title,
        },
        pdf: {
          pages: pdfInspection.structuredContent.pageCount,
          text: pdfText.structuredContent.pages[0].text,
          width: pdfImageMetadata.width,
          height: pdfImageMetadata.height,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await handle.close();
  await fs.rm(root, { recursive: true, force: true });
}
