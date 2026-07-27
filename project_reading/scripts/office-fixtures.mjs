import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export async function writeOfficeSmokeFixtures(directory) {
  await Promise.all([
    writeDocx(path.join(directory, "sample.docx")),
    writePptx(path.join(directory, "sample.pptx")),
  ]);
}

async function writeDocx(filePath) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Smoke document</w:t></w:r></w:p>
    <w:p><w:r><w:t>Word extraction ready</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ready</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>`,
  );
  await fs.writeFile(
    filePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function writePptx(filePath) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Smoke presentation</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>PowerPoint extraction ready</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  await fs.writeFile(
    filePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}
