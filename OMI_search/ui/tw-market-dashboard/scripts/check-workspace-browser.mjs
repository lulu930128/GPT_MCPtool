// Usage: node scripts/check-workspace-browser.mjs <installed Chromium executable>
// Uses file://, a disposable profile and a synthetic host; never connects to OMI.
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

if (!process.argv[2]) throw new Error("Pass an installed Chromium executable; no browser is downloaded.");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const run = await mkdtemp(path.join(root, ".tmp", "workspace-browser-"));
const output = await build({ entryPoints: [path.join(root, "scripts/workspace-browser-fixture.tsx")], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" } });
const child = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></html>`;
for (const width of [1440, 1280, 1150, 900, 650, 390]) {
  const html = path.join(run, `fixture-${width}.html`);
  // A real parent is essential: self-hosting lets the bridge mistake its own
  // outgoing request for a reply. Keep production transport unchanged.
  const host = `const frame=document.querySelector('iframe');
window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||!event.data?.id)return;const m=event.data;const result=m.method==='tools/call'?await event.source.workspaceFixtureTool(m.params):{};event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
frame.srcdoc=${JSON.stringify(child)};
const poll=setInterval(()=>{const status=frame.contentDocument?.body?.dataset.testResult;if(status){document.body.dataset.testResult=status;clearInterval(poll);}},20);`;
  await writeFile(html, `<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#0c1118"><iframe style="border:0;display:block;width:${width}px;height:1500px"></iframe><script>${host.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
  const screenshot = path.join(run, `workspace-${width}.png`);
  const result = spawnSync(process.argv[2], ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--no-default-browser-check", `--user-data-dir=${path.join(run, `profile-${width}`)}`, `--window-size=${Math.max(500,width)},1500`, "--virtual-time-budget=60000", "--dump-dom", `--screenshot=${screenshot}`, pathToFileURL(html).href], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
  await writeFile(path.join(run, `result-${width}.html`), result.stdout ?? "");
  const outcome = result.stdout?.match(/data-test-result="([^"]+)"/)?.[1];
  if (result.error || result.status !== 0 || !outcome?.startsWith("PASS")) throw new Error(`${width}: ${outcome ?? result.error ?? `browser exit ${result.status}; no result`}\n${result.stderr?.slice(-1500) ?? ""}`);
  console.log(`${outcome}; screenshot ${screenshot}`);
}
