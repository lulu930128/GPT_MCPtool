import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import sharp from "sharp";
import {
  inspectAsset,
  readDocumentAsset,
  readImageAsset,
  readPresentationAsset,
  readSpreadsheetAsset,
} from "../src/assets.js";
import { loadConfig, type ServerConfig } from "../src/config.js";

test("asset scopes reject paths that escape their inner boundary", async () => {
  const fixture = await makeAssetFixture();
  await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: "#ff0000",
    },
  })
    .png()
    .toFile(path.join(fixture.root, "outside.png"));

  await assert.rejects(
    () => inspectAsset(fixture.config, { scope: "media", path: "../outside.png" }),
    /escapes the configured asset scope/,
  );
});

test("readImageAsset re-encodes a bounded image and strips metadata", async () => {
  const fixture = await makeAssetFixture();
  const imagePath = path.join(fixture.assets, "sample.webp");
  await sharp({
    create: {
      width: 640,
      height: 320,
      channels: 4,
      background: { r: 10, g: 120, b: 220, alpha: 0.6 },
    },
  })
    .webp()
    .toFile(imagePath);

  const inspected = (await inspectAsset(fixture.config, {
    scope: "media",
    path: "sample.webp",
  })) as { kind: string; width: number; height: number };
  assert.equal(inspected.kind, "image");
  assert.equal(inspected.width, 640);
  assert.equal(inspected.height, 320);

  const result = await readImageAsset(fixture.config, {
    scope: "media",
    path: "sample.webp",
    maxDimension: 128,
  });
  const decoded = Buffer.from(result.data, "base64");
  const outputMetadata = await sharp(decoded).metadata();

  assert.equal(result.mimeType, "image/png");
  assert.equal(outputMetadata.width, 128);
  assert.equal(outputMetadata.height, 64);
  assert.equal(result.metadata.metadataStripped, true);
  assert.ok(decoded.length <= fixture.config.maxImageOutputBytes);
});

test("readImageAsset accepts GIF and returns a static safe preview", async () => {
  const fixture = await makeAssetFixture();
  const gifPath = path.join(fixture.assets, "sample.gif");
  const pixels = Buffer.alloc(80 * 80 * 3);
  for (let y = 0; y < 80; y += 1) {
    const color = y < 40 ? [136, 68, 204] : [42, 176, 92];
    for (let x = 0; x < 80; x += 1) {
      const offset = (y * 80 + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  await sharp(pixels, {
    raw: {
      width: 80,
      height: 80,
      pageHeight: 40,
      channels: 3,
    },
  })
    .gif({ delay: [80, 80], loop: 0 })
    .toFile(gifPath);

  const inspected = (await inspectAsset(fixture.config, {
    scope: "media",
    path: "sample.gif",
  })) as { format: string; pages: number };
  assert.equal(inspected.format, "gif");
  assert.equal(inspected.pages, 2);

  const result = await readImageAsset(fixture.config, {
    scope: "media",
    path: "sample.gif",
  });
  const metadata = result.metadata as {
    sourceFormat: string;
    sourcePages: number;
    animationDiscarded: boolean;
  };
  assert.equal(metadata.sourceFormat, "gif");
  assert.equal(metadata.sourcePages, 2);
  assert.equal(metadata.animationDiscarded, true);
  assert.equal(result.mimeType, "image/png");
});

test("readSpreadsheetAsset returns bounded values and suppresses hyperlink targets", async () => {
  const fixture = await makeAssetFixture();
  const workbookPath = path.join(fixture.assets, "sample.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Summary");
  worksheet.getCell("A1").value = "name";
  worksheet.getCell("B1").value = "amount";
  worksheet.getCell("A2").value = "demo";
  worksheet.getCell("B2").value = 42;
  worksheet.getCell("C2").value = { formula: "B2*2", result: 84 };
  worksheet.getCell("D2").value = {
    text: "OpenAI",
    hyperlink: "https://example.invalid/private",
  };
  worksheet.getCell("E2").value = {
    formula: 'HYPERLINK("https://formula.example.invalid/private","click")',
    result: "click",
  };
  await workbook.xlsx.writeFile(workbookPath);

  const inspected = (await inspectAsset(fixture.config, {
    scope: "media",
    path: "sample.xlsx",
  })) as { kind: string; entries: number };
  assert.equal(inspected.kind, "spreadsheet");
  assert.ok(inspected.entries > 0);

  const result = (await readSpreadsheetAsset(fixture.config, {
    scope: "media",
    path: "sample.xlsx",
    sheet: "Summary",
    range: "A1:E2",
  })) as {
    returnedRange: string;
    rows: unknown[][];
    formulas: number;
    hyperlinksSuppressed: number;
    warnings: string[];
  };

  assert.equal(result.returnedRange, "A1:E2");
  assert.equal(result.rows[1]?.[1], 42);
  assert.deepEqual(result.rows[1]?.[2], { formula: "B2*2", result: 84 });
  assert.deepEqual(result.rows[1]?.[3], { text: "OpenAI", hyperlinkPresent: true });
  assert.deepEqual(result.rows[1]?.[4], {
    formula: "HYPERLINK(...)",
    result: "click",
    hyperlinkPresent: true,
  });
  assert.equal(result.formulas, 2);
  assert.equal(result.hyperlinksSuppressed, 2);
  assert.match(result.warnings.join(" "), /Hyperlink targets were not returned/);
  assert.doesNotMatch(JSON.stringify(result), /example\.invalid/);
});

test("readSpreadsheetAsset truncates large requested ranges to configured cell limits", async () => {
  const fixture = await makeAssetFixture();
  const workbookPath = path.join(fixture.assets, "bounded.xlsx");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Data").getCell("A1").value = "only";
  await workbook.xlsx.writeFile(workbookPath);

  const result = (await readSpreadsheetAsset(fixture.config, {
    scope: "media",
    path: "bounded.xlsx",
    range: "A1:ZZ1000",
    maxRows: 10,
    maxColumns: 10,
    maxCells: 25,
  })) as {
    returnedRange: string;
    rowCount: number;
    columnCount: number;
    cellCount: number;
    truncated: boolean;
  };

  assert.equal(result.returnedRange, "A1:B10");
  assert.equal(result.rowCount, 10);
  assert.equal(result.columnCount, 2);
  assert.equal(result.cellCount, 20);
  assert.equal(result.truncated, true);
});

test("readSpreadsheetAsset rejects files that are not valid XLSX containers", async () => {
  const fixture = await makeAssetFixture();
  await fs.writeFile(path.join(fixture.assets, "fake.xlsx"), "not a zip", "utf8");

  await assert.rejects(
    () =>
      readSpreadsheetAsset(fixture.config, {
        scope: "media",
        path: "fake.xlsx",
      }),
    /Spreadsheet container is invalid/,
  );
});

test("readDocumentAsset extracts paragraphs and tables while excluding tracked deletions", async () => {
  const fixture = await makeAssetFixture();
  const documentPath = path.join(fixture.assets, "sample.docx");
  await writeDocxFixture(documentPath);

  const inspected = (await inspectAsset(fixture.config, {
    scope: "media",
    path: "sample.docx",
  })) as {
    kind: string;
    readableBy: string;
    externalRelationships: number;
  };
  assert.equal(inspected.kind, "word_document");
  assert.equal(inspected.readableBy, "read_document");
  assert.equal(inspected.externalRelationships, 1);

  const result = (await readDocumentAsset(fixture.config, {
    scope: "media",
    path: "sample.docx",
  })) as {
    blocks: Array<Record<string, unknown>>;
    summary: {
      trackedInsertions: number;
      trackedDeletionsExcluded: number;
      externalRelationshipsSuppressed: number;
    };
  };
  assert.deepEqual(result.blocks[0], {
    type: "paragraph",
    text: "Quarterly brief",
    style: "Heading1",
    headingLevel: 1,
  });
  assert.deepEqual(result.blocks[1], {
    type: "paragraph",
    text: "Hello world",
  });
  assert.deepEqual(result.blocks[2], {
    type: "table",
    rows: [
      ["Item", "Value"],
      ["Revenue", "42"],
    ],
    rowCount: 2,
    columnCount: 2,
  });
  assert.equal(result.summary.trackedInsertions, 1);
  assert.equal(result.summary.trackedDeletionsExcluded, 1);
  assert.equal(result.summary.externalRelationshipsSuppressed, 1);
  assert.doesNotMatch(JSON.stringify(result), /deleted text|external\.example/);
});

test("readDocumentAsset rejects macro-bearing DOCX packages", async () => {
  const fixture = await makeAssetFixture();
  const documentPath = path.join(fixture.assets, "macro.docx");
  await writeDocxFixture(documentPath, {
    "word/vbaProject.bin": Buffer.from([0, 1, 2, 3]),
  });

  await assert.rejects(
    () =>
      readDocumentAsset(fixture.config, {
        scope: "media",
        path: "macro.docx",
      }),
    /macros, ActiveX, OLE, or embedded objects/,
  );
});

test("readDocumentAsset rejects XML declarations that can define entities", async () => {
  const fixture = await makeAssetFixture();
  const documentPath = path.join(fixture.assets, "entity.docx");
  await writeDocxFixture(documentPath, {
    "word/document.xml": `<?xml version="1.0"?>
<!DOCTYPE w:document [<!ENTITY injected "unsafe">]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>&injected;</w:t></w:r></w:p></w:body>
</w:document>`,
  });

  await assert.rejects(
    () =>
      readDocumentAsset(fixture.config, {
        scope: "media",
        path: "entity.docx",
      }),
    /DTD or entity declaration/,
  );
});

test("readPresentationAsset preserves slide order and optionally includes speaker notes", async () => {
  const fixture = await makeAssetFixture();
  const presentationPath = path.join(fixture.assets, "sample.pptx");
  await writePptxFixture(presentationPath);

  const inspected = (await inspectAsset(fixture.config, {
    scope: "media",
    path: "sample.pptx",
  })) as {
    kind: string;
    readableBy: string;
    slideCount: number;
    externalRelationships: number;
  };
  assert.equal(inspected.kind, "presentation");
  assert.equal(inspected.readableBy, "read_presentation");
  assert.equal(inspected.slideCount, 2);
  assert.equal(inspected.externalRelationships, 1);

  const result = (await readPresentationAsset(fixture.config, {
    scope: "media",
    path: "sample.pptx",
    includeNotes: true,
  })) as {
    slides: Array<{
      number: number;
      title: string;
      texts: string[];
      notes: string[];
    }>;
    totalSlides: number;
    summary: { externalRelationshipsSuppressed: number };
  };
  assert.equal(result.totalSlides, 2);
  assert.equal(result.slides[0]?.title, "Second slide");
  assert.deepEqual(result.slides[0]?.texts, ["Second slide", "Shown first"]);
  assert.deepEqual(result.slides[0]?.notes, ["Private speaker note"]);
  assert.equal(result.slides[1]?.title, "First slide");
  assert.deepEqual(result.slides[1]?.notes, []);
  assert.equal(result.summary.externalRelationshipsSuppressed, 1);
  assert.doesNotMatch(JSON.stringify(result), /external\.example/);
});

async function makeAssetFixture(): Promise<{
  root: string;
  assets: string;
  config: ServerConfig;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-assets-"));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets);
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
    WORKSPACE_MCP_ASSET_SCOPES: "media=projects:assets",
    WORKSPACE_MCP_MAX_IMAGE_OUTPUT_BYTES: "1048576",
  });
  return { root, assets, config };
}

async function writeDocxFixture(
  filePath: string,
  extraParts: Record<string, string | Buffer> = {},
): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Quarterly brief</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
      <w:ins><w:r><w:t>world</w:t></w:r></w:ins>
      <w:del><w:r><w:delText>deleted text</w:delText></w:r></w:del>
    </w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://external.example/private" TargetMode="External"/>
</Relationships>`,
  );
  for (const [name, content] of Object.entries(extraParts)) {
    zip.file(name, content);
  }
  await fs.writeFile(
    filePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function writePptxFixture(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`,
  );
  zip.file("ppt/slides/slide1.xml", slideXml("First slide", "Shown second"));
  zip.file("ppt/slides/slide2.xml", slideXml("Second slide", "Shown first"));
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://external.example/private" TargetMode="External"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Private speaker note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`,
  );
  await fs.writeFile(
    filePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

function slideXml(title: string, body: string): string {
  return `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
}
