// Usage: node scripts/check-synthetic-order-browser.mjs <installed Chromium executable>
// Disposable file:// fixture only; no server, host bridge, download or production runtime.
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

if (!process.argv[2]) throw new Error("Pass an installed Chromium executable; no browser is downloaded.");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const run = await mkdtemp(path.join(root, ".tmp", "synthetic-order-browser-"));
const output = await build({ entryPoints: [path.join(root, "scripts/synthetic-order-browser-fixture.tsx")], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" } });
const html = path.join(run, "fixture.html");
await writeFile(html, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'"><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></html>`);
for (const width of [1440, 390]) {
  const screenshot = path.join(run, `synthetic-order-${width}.png`);
  const result = spawnSync(process.argv[2], ["--headless", "--disable-gpu", "--in-process-gpu", "--no-first-run", "--disable-background-networking", "--no-default-browser-check", `--user-data-dir=${path.join(run, `profile-${width}`)}`, `--window-size=${width},1600`, "--virtual-time-budget=8000", "--timeout=15000", "--dump-dom", `--screenshot=${screenshot}`, pathToFileURL(html).href], { encoding: "utf8", windowsHide: true, timeout: 25_000, maxBuffer: 10 * 1024 * 1024 });
  const outcome = result.stdout?.match(/data-test-result="([^"]+)"/)?.[1];
  if (result.error || result.status !== 0 || !outcome?.startsWith("PASS")) throw new Error(`${width}: ${outcome ?? result.error ?? `browser exit ${result.status}; no result`}\n${result.stderr?.slice(-1500) ?? ""}`);
  console.log(`${outcome}; screenshot ${screenshot}`);
}
