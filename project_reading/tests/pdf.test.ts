import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { inspectPdf, readPdfPage, readPdfText } from "../src/pdf.js";

test("PDF tools inspect, extract bounded text, and render a page", async () => {
  const fixture = await makePdfFixture();
  const inspected = (await inspectPdf(fixture.config, {
    scope: "media",
    path: "sample.pdf",
  })) as {
    pageCount: number;
    metadata: { title: string };
    safety: { encrypted: boolean; embeddedFiles: boolean; externalTargetsFetched: boolean };
  };
  assert.equal(inspected.pageCount, 2);
  assert.equal(inspected.metadata.title, "Bounded PDF Fixture");
  assert.deepEqual(inspected.safety, {
    encrypted: false,
    javascriptActions: false,
    openAction: false,
    embeddedFiles: false,
    activeAnnotations: false,
    externalTargetsFetched: false,
  });

  const textResult = (await readPdfText(fixture.config, {
    scope: "media",
    path: "sample.pdf",
    pageStart: 2,
    pageCount: 1,
    maxChars: 40,
  })) as {
    pages: Array<{ page: number; text: string }>;
    returnedPageCount: number;
  };
  assert.equal(textResult.returnedPageCount, 1);
  assert.equal(textResult.pages[0]?.page, 2);
  assert.match(textResult.pages[0]?.text ?? "", /Second page/);

  const rendered = await readPdfPage(fixture.config, {
    scope: "media",
    path: "sample.pdf",
    page: 1,
    maxDimension: 512,
  });
  const image = Buffer.from(rendered.data, "base64");
  const metadata = await sharp(image).metadata();
  assert.equal(rendered.mimeType, "image/png");
  assert.ok((metadata.width ?? 0) <= 512);
  assert.ok((metadata.height ?? 0) <= 512);
  assert.equal(rendered.metadata.metadataStripped, true);
});

test("PDF tools reject extension/content mismatch and absolute asset paths", async () => {
  const fixture = await makePdfFixture();
  await fs.writeFile(path.join(fixture.assets, "fake.pdf"), "not a pdf", "utf8");

  await assert.rejects(
    () => inspectPdf(fixture.config, { scope: "media", path: "fake.pdf" }),
    /do not match/,
  );
  await assert.rejects(
    () => inspectPdf(fixture.config, { scope: "media", path: path.join(fixture.assets, "sample.pdf") }),
    /relative path/,
  );
});

async function makePdfFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-"));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets);
  const pdf = await PDFDocument.create();
  pdf.setTitle("Bounded PDF Fixture");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText("First page technical diagram", { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  const second = pdf.addPage([612, 792]);
  second.drawText("Second page bounded text", { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  await fs.writeFile(path.join(assets, "sample.pdf"), await pdf.save({ useObjectStreams: false }));
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
    WORKSPACE_MCP_ASSET_SCOPES: "media=projects:assets",
    WORKSPACE_MCP_MAX_PDF_RENDER_DIMENSION: "1024",
    WORKSPACE_MCP_MAX_PDF_OUTPUT_BYTES: "2097152",
  });
  return { root, assets, config };
}
