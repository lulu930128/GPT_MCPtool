// Offline file/srcdoc fixtures with disposable browser profiles; no server.
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

if (!process.argv[2]) throw Error("Pass an existing Chromium executable; no download.");
const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, ".tmp");
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(path.join(artifacts, "desk-orders-"));
const output = await build({ entryPoints: [path.join(root, "scripts/desk-orders-browser-fixture.tsx")], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" } });
for (const width of [390, 650, 1280]) for (const mode of ["presentation", "interaction", "submission"]) {
  const child = `<!doctype html><html lang="zh-Hant" data-fixture-mode="${mode}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><pre id="fixture-receipt" hidden></pre><script>${output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></html>`;
  const host = `const frame=document.querySelector('iframe');frame.srcdoc=${JSON.stringify(child)};const poll=setInterval(()=>{const outcome=frame.contentDocument?.body?.dataset.testResult;if(outcome){document.body.dataset.testResult=outcome;clearInterval(poll);}},20);`;
  const html = path.join(run, `${mode}-${width}.html`), screenshot = path.join(run, `${mode}-${width}.png`);
  await writeFile(html, `<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#090d13"><iframe style="border:0;display:block;width:${width}px;height:1500px"></iframe><script>${host.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
  const result = spawnSync(process.argv[2], ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--no-default-browser-check", `--user-data-dir=${path.join(run, `profile-${mode}-${width}`)}`, `--window-size=${Math.max(500,width)},1500`, "--virtual-time-budget=15000", "--dump-dom", `--screenshot=${screenshot}`, pathToFileURL(html).href], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(path.join(run, `result-${mode}-${width}.html`), result.stdout ?? "");
  const outcome = result.stdout?.match(/<body[^>]*data-test-result="([^"]+)"/)?.[1];
  if (result.error || result.status !== 0 || !outcome?.startsWith("PASS")) throw Error(`${outcome ?? result.error ?? result.status}; artifacts: ${run}`);
  console.log(`${outcome}; screenshot: ${screenshot}`);
}
