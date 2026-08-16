import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, type ServerConfig } from "../src/config.js";
import {
  createAssetResourceUri,
  fetchAsset,
  inferMimeType,
  parseAssetResourceUri,
  readAssetResource,
} from "../src/file-transfer.js";
import { getWorkspaceInfo } from "../src/workspace.js";

test("fetchAsset returns original bytes with stable metadata", async (t) => {
  const fixture = await makeFixture(t);
  const nested = path.join(fixture.assets, "雪雪 圖片");
  await fs.mkdir(nested);
  const source = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x7f, 0xff, 0x10]);
  const sha256 = createHash("sha256").update(source).digest("hex");
  await fs.writeFile(path.join(nested, "原圖 #1.png"), source);

  const result = await fetchAsset(fixture.config, {
    scope: "media",
    path: "雪雪 圖片/原圖 #1.png",
  });

  assert.deepEqual(Buffer.from(result.data, "base64"), source);
  assert.deepEqual(result.metadata, {
    ok: true,
    scope: "media",
    path: "雪雪 圖片/原圖 #1.png",
    filename: "原圖 #1.png",
    bytes: source.length,
    mimeType: "image/png",
    sha256,
    transfer: "resource_link",
    resourceUri:
      `workspace-asset:///media/%E9%9B%AA%E9%9B%AA%20%E5%9C%96%E7%89%87/%E5%8E%9F%E5%9C%96%20%231.png?sha256=${sha256}`,
  });
  assert.equal(result.resourceUri, result.metadata.resourceUri);
  assert.equal(result.mimeType, "image/png");
});

test("resource links round-trip original bytes and reject changed content", async (t) => {
  const fixture = await makeFixture(t);
  const filePath = path.join(fixture.assets, "download.txt");
  await fs.writeFile(filePath, "first", "utf8");

  const linked = await fetchAsset(fixture.config, {
    scope: "media",
    path: "download.txt",
  });
  const read = await readAssetResource(fixture.config, linked.resourceUri);
  assert.equal(Buffer.from(read.data, "base64").toString("utf8"), "first");
  assert.deepEqual(parseAssetResourceUri(linked.resourceUri), {
    scope: "media",
    path: "download.txt",
    sha256: linked.metadata.sha256,
  });

  await fs.writeFile(filePath, "second", "utf8");
  await assert.rejects(
    () => readAssetResource(fixture.config, linked.resourceUri),
    /changed since the resource link was created/,
  );
});

test("resource URI parser rejects non-canonical or unbound references", () => {
  const sha256 = "a".repeat(64);
  for (const uri of [
    `https:///media/a.txt?sha256=${sha256}`,
    "workspace-asset:///media/a.txt",
    `workspace-asset:///media/../a.txt?sha256=${sha256}`,
    `workspace-asset:///media/a.txt?sha256=${sha256}&extra=1`,
    `workspace-asset:///media/a.txt?sha256=${sha256}#fragment`,
  ]) {
    assert.throws(() => parseAssetResourceUri(uri), /workspace asset resource URI|SHA-256/);
  }
});

test("original file return is disabled unless the asset scope is explicitly enabled", async (t) => {
  const fixture = await makeFixture(t, 1024, false);
  await fs.writeFile(path.join(fixture.assets, "blocked.txt"), "blocked", "utf8");

  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "blocked.txt" }),
    /Original file return is not enabled/,
  );
});

test("fetchAsset enforces the configured size limit before returning content", async (t) => {
  const fixture = await makeFixture(t, 4);
  await fs.writeFile(path.join(fixture.assets, "too-large.txt"), "12345", "utf8");

  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "too-large.txt" }),
    /fetch limit of 4 bytes/,
  );
});

test("fetchAsset preserves path guard, scope, file-type, and deny failures", async (t) => {
  const fixture = await makeFixture(t);
  await fs.writeFile(path.join(fixture.root, "outside.txt"), "outside", "utf8");
  await fs.mkdir(path.join(fixture.assets, "folder"));
  for (const [name, content] of [
    [".env", "SECRET=1"],
    ["credentials.json", "{}"],
    ["archive.zip", "zip"],
    ["state.db", "db"],
  ] as const) {
    await fs.writeFile(path.join(fixture.assets, name), content, "utf8");
  }

  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "../outside.txt" }),
    /escapes the configured asset scope/,
  );
  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "C:\\Windows\\win.ini" }),
    /relative path/,
  );
  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "unknown", path: "file.txt" }),
    /Unknown asset scope/,
  );
  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "folder" }),
    /not a regular file/,
  );
  for (const name of [".env", "credentials.json", "archive.zip", "state.db"]) {
    await assert.rejects(
      () => fetchAsset(fixture.config, { scope: "media", path: name }),
      /denied file (?:name|extension)/,
    );
  }
});

test("fetchAsset rejects a symlink or junction that resolves outside the root", async (t) => {
  const fixture = await makeFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-fetch-outside-"));
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "outside.txt"), "outside", "utf8");

  try {
    await fs.symlink(
      outside,
      path.join(fixture.assets, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This Windows account cannot create a test junction.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => fetchAsset(fixture.config, { scope: "media", path: "escape/outside.txt" }),
    /escapes the configured workspace root/,
  );
});

test("fetch metadata helpers use bounded defaults and deterministic MIME fallbacks", async (t) => {
  const fixture = await makeFixture(t);
  const info = (await getWorkspaceInfo(fixture.config)) as {
    assetScopes: Array<{ id: string; originalFileReturnAllowed: boolean }>;
    limits: { fetch: { maxFileBytes: number; enabledScopes: string[] } };
  };

  assert.equal(fixture.config.maxFetchFileBytes, 1024);
  assert.equal(info.limits.fetch.maxFileBytes, 1024);
  assert.deepEqual(info.limits.fetch.enabledScopes, ["media"]);
  assert.equal(info.assetScopes[0]?.originalFileReturnAllowed, true);
  assert.equal(inferMimeType("report.DOCX"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(inferMimeType("asset.unknown"), "application/octet-stream");
  const sha256 = "b".repeat(64);
  assert.equal(
    createAssetResourceUri("scope id", "a/b c.txt", sha256),
    `workspace-asset:///scope%20id/a/b%20c.txt?sha256=${sha256}`,
  );
});

async function makeFixture(
  t: TestContext,
  maxFetchFileBytes = 1024,
  enableFileReturn = true,
): Promise<{ root: string; assets: string; config: ServerConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-fetch-"));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets);
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
    WORKSPACE_MCP_ASSET_SCOPES: "media=projects:assets",
    ...(enableFileReturn ? { WORKSPACE_MCP_FILE_RETURN_SCOPES: "media" } : {}),
    WORKSPACE_MCP_MAX_FETCH_FILE_BYTES: String(maxFetchFileBytes),
  });
  return { root, assets, config };
}
