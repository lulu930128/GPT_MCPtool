import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
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

const config = await loadConfig({
  WORKSPACE_MCP_ROOTS: `smoke=${root}`,
  WORKSPACE_MCP_DEFAULT_ROOT: "smoke",
  WORKSPACE_MCP_ASSET_SCOPES: "media=smoke:assets",
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
    clientInfo: { name: "asset-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.version, "0.5.0");

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

  console.log(
    JSON.stringify(
      {
        ok: true,
        serverVersion: initialized.serverInfo.version,
        image: {
          mimeType: imageContent.mimeType,
          width: imageMetadata.width,
          height: imageMetadata.height,
          bytes: decodedImage.length,
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
      },
      null,
      2,
    ),
  );
} finally {
  await handle.close();
  await fs.rm(root, { recursive: true, force: true });
}
