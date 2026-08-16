import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { writeOfficeSmokeFixtures } from "./office-fixtures.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = await fs.mkdtemp(path.join(projectRoot, ".asset-live-smoke-"));
const relativeFixture = `project_reading/${path.basename(fixtureDir)}`;
const mcpUrl = process.env.WORKSPACE_MCP_SMOKE_URL?.trim() || "http://127.0.0.1:18787/mcp";
const bearerToken = process.env.WORKSPACE_MCP_SMOKE_TOKEN?.trim();
const externalFetchScope = process.env.WORKSPACE_MCP_LIVE_FETCH_SCOPE?.trim();
const externalFetchPath = process.env.WORKSPACE_MCP_LIVE_FETCH_PATH?.trim();
const externalFetchAbsolute = process.env.WORKSPACE_MCP_LIVE_FETCH_ABSOLUTE?.trim();
if (
  [externalFetchScope, externalFetchPath, externalFetchAbsolute].some(Boolean) &&
  ![externalFetchScope, externalFetchPath, externalFetchAbsolute].every(Boolean)
) {
  throw new Error(
    "WORKSPACE_MCP_LIVE_FETCH_SCOPE, WORKSPACE_MCP_LIVE_FETCH_PATH, and WORKSPACE_MCP_LIVE_FETCH_ABSOLUTE must be set together.",
  );
}
let nextId = 1;
let sessionId;

try {
  await sharp({
    create: {
      width: 240,
      height: 120,
      channels: 3,
      background: "#225577",
    },
  })
    .gif()
    .toFile(path.join(fixtureDir, "live.gif"));

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Live");
  worksheet.addRow(["status", "count"]);
  worksheet.addRow(["ready", 2]);
  await workbook.xlsx.writeFile(path.join(fixtureDir, "live.xlsx"));
  await writeOfficeSmokeFixtures(fixtureDir);
  const pdf = await PDFDocument.create();
  pdf.setTitle("Project Reading live PDF smoke");
  const pdfFont = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([360, 480]).drawText("Live PDF reader ready", {
    x: 36,
    y: 400,
    size: 18,
    font: pdfFont,
  });
  await fs.writeFile(
    path.join(fixtureDir, "live.pdf"),
    await pdf.save({ useObjectStreams: false }),
  );

  async function rpc(method, params) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
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
    clientInfo: { name: "live-asset-smoke", version: "1.5.0" },
  });
  assert.equal(initialized.serverInfo.version, "1.5.0");

  const resourceTemplates = await rpc("resources/templates/list", {});
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "workspace-asset:///{scope}/{+path}",
    ),
  );

  const image = await rpc("tools/call", {
    name: "read_image",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/live.gif`,
      maxDimension: 120,
    },
  });
  const imageContent = image.content.find((item) => item.type === "image");
  assert.equal(imageContent?.mimeType, "image/png");
  const imageMetadata = await sharp(Buffer.from(imageContent.data, "base64")).metadata();
  assert.equal(imageMetadata.width, 120);
  assert.equal(imageMetadata.height, 60);

  const fetched = await rpc("tools/call", {
    name: "fetch_asset",
    arguments: {
      scope: externalFetchScope || "mcp_tools",
      path: externalFetchPath || `${relativeFixture}/live.gif`,
    },
  });
  const fetchedResource = fetched.content.find((item) => item.type === "resource_link");
  const originalImage = await fs.readFile(
    externalFetchAbsolute || path.join(fixtureDir, "live.gif"),
  );
  const readResource = await rpc("resources/read", { uri: fetchedResource.uri });
  const returnedResource = readResource.contents[0];
  const fetchedBytes = Buffer.from(returnedResource.blob, "base64");
  assert.deepEqual(fetchedBytes, originalImage);
  assert.equal(fetchedResource.mimeType, fetched.structuredContent.mimeType);
  assert.equal(returnedResource.mimeType, fetched.structuredContent.mimeType);
  assert.equal(
    fetched.structuredContent.sha256,
    createHash("sha256").update(originalImage).digest("hex"),
  );

  const spreadsheet = await rpc("tools/call", {
    name: "read_spreadsheet",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/live.xlsx`,
      range: "A1:B2",
    },
  });
  const spreadsheetText = spreadsheet.content.find((item) => item.type === "text")?.text;
  const spreadsheetResult = JSON.parse(spreadsheetText);
  assert.deepEqual(spreadsheetResult.rows, [
    ["status", "count"],
    ["ready", 2],
  ]);

  const document = await rpc("tools/call", {
    name: "read_document",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/sample.docx`,
    },
  });
  const documentResult = JSON.parse(
    document.content.find((item) => item.type === "text")?.text,
  );
  assert.equal(documentResult.blocks[0].text, "Smoke document");

  const presentation = await rpc("tools/call", {
    name: "read_presentation",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/sample.pptx`,
    },
  });
  const presentationResult = JSON.parse(
    presentation.content.find((item) => item.type === "text")?.text,
  );
  assert.equal(presentationResult.slides[0].title, "Smoke presentation");

  const pdfInspection = await rpc("tools/call", {
    name: "inspect_pdf",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/live.pdf`,
    },
  });
  assert.equal(pdfInspection.structuredContent.pageCount, 1);
  assert.equal(pdfInspection.structuredContent.metadata.title, "Project Reading live PDF smoke");

  const pdfText = await rpc("tools/call", {
    name: "read_pdf_text",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/live.pdf`,
      pageCount: 1,
    },
  });
  assert.match(pdfText.structuredContent.pages[0].text, /Live PDF reader ready/);

  const pdfPage = await rpc("tools/call", {
    name: "read_pdf_page",
    arguments: {
      scope: "mcp_tools",
      path: `${relativeFixture}/live.pdf`,
      page: 1,
      maxDimension: 256,
    },
  });
  const pdfImageContent = pdfPage.content.find((item) => item.type === "image");
  assert.equal(pdfImageContent?.mimeType, "image/png");
  const pdfImageMetadata = await sharp(Buffer.from(pdfImageContent.data, "base64")).metadata();
  assert.ok(pdfImageMetadata.width <= 256);
  assert.ok(pdfImageMetadata.height <= 256);

  const denied = await rpc("tools/call", {
    name: "inspect_asset",
    arguments: {
      scope: "mcp_tools",
      path: "project_reading/.secrets/not-a-real-image.png",
    },
  });
  const deniedResult = JSON.parse(denied.content.find((item) => item.type === "text")?.text);
  assert.equal(deniedResult.ok, false);
  assert.match(deniedResult.error, /denied directory/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        serverVersion: initialized.serverInfo.version,
        image: {
          mimeType: imageContent.mimeType,
          width: imageMetadata.width,
          height: imageMetadata.height,
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
        deniedSecretScope: true,
      },
      null,
      2,
    ),
  );
} finally {
  const parent = path.dirname(fixtureDir);
  if (
    path.resolve(parent) === path.resolve(projectRoot) &&
    path.basename(fixtureDir).startsWith(".asset-live-smoke-")
  ) {
    await fs.rm(fixtureDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
  }
}
