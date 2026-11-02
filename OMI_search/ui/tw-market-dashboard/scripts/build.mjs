import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Component-owned source updates compile a captured source tree to an isolated
// candidate, using the same installed builder. These options are never MCP input.
let sourceRoot = projectRoot;
let outputRoot = path.join(projectRoot, "dist");
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const value = args[index + 1];
  if (!value || !["--source-dir", "--output-dir"].includes(args[index])) throw new Error("Unsupported build arguments");
  if (args[index] === "--source-dir") sourceRoot = path.resolve(value);
  else outputRoot = path.resolve(value);
}
const output = await build({
  entryPoints: [path.join(sourceRoot, "src", "main.tsx")],
  nodePaths: [path.join(projectRoot, "node_modules")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  write: false,
  outfile: path.join(outputRoot, "component.js"),
  loader: { ".css": "text" },
});
const javascript = output.outputFiles.find((file) => file.path.endsWith(".js"));
if (!javascript) throw new Error("esbuild did not produce a JavaScript bundle");
const safeJavascript = javascript.text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>OMI 台股市場儀表板</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${safeJavascript}</script>
  </body>
</html>
`;
const dist = outputRoot;
await mkdir(dist, { recursive: true });
await writeFile(path.join(dist, "index.html"), html, "utf8");
console.log(`built ${path.join(dist, "index.html")} (${Buffer.byteLength(html)} bytes)`);
