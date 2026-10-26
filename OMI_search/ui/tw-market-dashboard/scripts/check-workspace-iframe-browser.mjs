// One bounded browser process, offline srcdoc iframe and synthetic MCP host.
// Usage: node scripts/check-workspace-iframe-browser.mjs <installed Chromium executable>
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

if (!process.argv[2]) throw new Error("Pass an installed Chromium executable; no download or retries.");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const run = await mkdtemp(path.join(root, ".tmp", "workspace-iframe-"));
const output = await build({ entryPoints: [path.join(root, "scripts/workspace-browser-fixture.tsx")], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" } });
const child = `<!doctype html><html lang="zh-Hant" data-fixture-mode="unknown"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></html>`;
const harness = `
const child = ${JSON.stringify(child)};
const results = [];
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
let frame;
window.addEventListener('message', async event => {
  if (event.source !== frame?.contentWindow || !event.data?.id) return;
  const message = event.data;
  const result = message.method === 'tools/call' ? await event.source.workspaceFixtureTool(message.params) : {};
  event.source.postMessage({jsonrpc:'2.0', id:message.id, result}, '*');
});
function height() {
  const doc = frame.contentDocument;
  // Intrinsic content measurement excludes the iframe's own scrollHeight floor.
  return Math.ceil(doc.getElementById('root').getBoundingClientRect().height);
}
window.workspaceFeedback = async phase => {
  const pageY = window.scrollY;
  const samples = [];
  for (const assigned of [180, 699, 700, 1100, 4000, 180]) {
    frame.style.height = assigned + 'px'; await pause(); samples.push(height());
  }
  check(Math.max(...samples) - Math.min(...samples) <= 1, phase + ': intrinsic height depends on iframe height ' + samples);
  const history = [];
  for (let round = 0; round < 20; round++) {
    frame.style.height = height() + 'px'; await pause(); history.push(height());
  }
  check(Math.max(...history) - Math.min(...history) <= 1, phase + ': resize feedback ' + history);
  check(history[0] > 400 && history[0] < 5000, phase + ': abnormal whole-widget height');
  const doc = frame.contentDocument;
  check(doc.documentElement.scrollWidth <= frame.contentWindow.innerWidth, phase + ': horizontal overflow');
  check(frame.contentWindow.getComputedStyle(doc.body).overflowY === 'visible', phase + ': body scroll trapped');
  check(window.scrollY === pageY, phase + ': host page auto-scrolled');
  results.push({width:frame.contentWindow.innerWidth, phase, samples, history});
};
async function run() {
  for (const width of [1440, 1150, 650, 390]) {
    frame = document.createElement('iframe');
    frame.style.cssText = 'display:block;border:0;width:' + width + 'px;height:180px';
    frame.srcdoc = child;
    document.getElementById('host').replaceChildren(frame);
    for (let attempt = 0; attempt < 1200; attempt++) {
      await pause();
      const status = frame.contentDocument?.body?.dataset.testResult;
      if (status?.startsWith('FAIL')) throw new Error(width + ': ' + status);
      if (status?.startsWith('PASS')) break;
      if (attempt === 1199) throw new Error(width + ': fixture did not finish');
    }
    for (const mode of ['inline', 'pip', 'fullscreen', 'inline']) {
      frame.contentWindow.openai.displayMode = mode;
      frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('openai:set_globals'));
      await pause();
      check(frame.contentDocument.querySelector('main').dataset.displayMode === mode, 'host displayMode not adopted');
      await window.workspaceFeedback('switch ' + mode);
    }
    // Let the actual 30s chart/watchlist/header polling timers run in virtual time.
    await pause(31000);
    await window.workspaceFeedback('scheduled polling');
    const tree = frame.contentDocument.querySelector('.workspace-group-scroll');
    frame.style.height = '180px'; await pause();
    tree.scrollTop = tree.scrollHeight;
    const last = tree.querySelector('[data-group-id="77"]').getBoundingClientRect();
    check(last.bottom <= tree.getBoundingClientRect().bottom + 1, 'last group inaccessible');
    frame.contentWindow.scrollTo(0, frame.contentDocument.documentElement.scrollHeight);
    const footer = frame.contentDocument.querySelector('footer').getBoundingClientRect();
    check(footer.bottom <= 181, 'short iframe cannot scroll to footer');
    frame.contentWindow.scrollTo(0, 0);
  }
  document.getElementById('results').textContent = JSON.stringify(results);
  document.body.dataset.testResult = 'PASS ' + results.length + ' iframe scenarios, 20 feedback rounds each';
}
run().catch(error => { document.body.dataset.testResult = 'FAIL ' + error.message; document.getElementById('results').textContent = JSON.stringify(results); });
`;
const html = path.join(run, "fixture.html");
await writeFile(html, `<!doctype html><html><meta charset="utf-8"><body style="margin:0"><div id="host"></div><pre id="results"></pre><script>${harness.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
const result = spawnSync(process.argv[2], ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--no-default-browser-check", `--user-data-dir=${path.join(run, "profile")}`, "--window-size=1500,1100", "--virtual-time-budget=180000", "--dump-dom", `--screenshot=${path.join(run, "iframe.png")}`, pathToFileURL(html).href], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 12 * 1024 * 1024 });
await writeFile(path.join(run, "result.html"), result.stdout ?? "");
const outcome = result.stdout?.match(/<body[^>]*data-test-result="([^"]+)"/)?.[1];
if (result.error || result.status !== 0 || !outcome?.startsWith("PASS")) throw new Error(`${outcome ?? result.error ?? `browser exit ${result.status}; no result`}; artifacts: ${run}\n${result.stderr?.slice(-1000) ?? ""}`);
console.log(`${outcome}; artifacts: ${run}`);
