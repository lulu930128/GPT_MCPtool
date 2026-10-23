// Offline Chromium acceptance. No package/browser download or production Bridge IO.
// node tests/workspace-ux-browser.test.mjs "C:\Program Files\Google\Chrome\Application\chrome.exe"
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

assert.ok(process.argv[2], "Pass an existing Chromium executable; no download is performed.");
const run = await mkdtemp(join(tmpdir(), "codex-workspace-ux-"));
const composerOnly = process.argv.includes("--composer-only");
const fixture = spawn(process.execPath, [new URL("../scripts/preview-workspace-fixture.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--keep-alive"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browser, socket;
const errors = [], externalRequests = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function outputMatch(stream, pattern) {
  let text = "";
  for await (const chunk of stream) { text += chunk; const match = text.match(pattern); if (match) return match[1]; }
  throw new Error("Process exited before readiness: " + text.slice(-1000));
}
try {
  const url = await Promise.race([outputMatch(fixture.stdout, /OFFLINE_FIXTURE (http:\/\/127\.0\.0\.1:\d+)/), delay(10000).then(() => { throw new Error("Fixture startup timeout"); })]);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal((await fetch(url + "/missing")).status, 404);
  browser = spawn(process.argv[2], ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + join(run, "profile"), "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const browserWs = await Promise.race([outputMatch(browser.stderr, /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/), delay(10000).then(() => { throw new Error("Browser startup timeout"); })]);
  const targets = await (await fetch(new URL("/json/list", browserWs.replace("ws:", "http:")))).json();
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const promise = pending.get(message.id); if (!promise) return; pending.delete(message.id); clearTimeout(promise.timer); message.error ? promise.reject(new Error(JSON.stringify(message.error))) : promise.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text + ": " + (message.params.exceptionDetails.exception?.description || ""));
    if (message.method === "Network.requestWillBeSent" && !message.params.request.url.startsWith(url) && !message.params.request.url.startsWith("data:")) externalRequests.push(message.params.request.url);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (source) => {
    const result = await send("Runtime.evaluate", { expression: source, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const app = (source) => evaluate(`(() => { const w=document.querySelector('iframe').contentWindow, d=w.document, $=s=>d.querySelector(s); return (()=>{${source}})(); })()`);
  const until = async (source) => { for (let i = 0; i < 100; i++) { if (await app(source)) return; await delay(50); } throw new Error("UI condition timed out: " + source); };
  const key = async (key, modifiers = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, modifiers }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers }); };
  const screenshot = async (name) => { const shot = await send("Page.captureScreenshot", { format: "png" }); const path = join(run, name + ".png"); await writeFile(path, Buffer.from(shot.data, "base64")); return path; };
  await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
  if (!composerOnly) {
  for (const width of [1728, 1280, 900, 390]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 893, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await send("Page.bringToFront");
    await delay(150);
    await until('return Boolean($(".markdown table") && $("#toggle-focus"));');
    assert.deepEqual(await app('return { font:w.getComputedStyle($(".message-body")).fontSize, inspector:w.getComputedStyle($("#workstream-panel")).display, expanded:$("#toggle-inspector").getAttribute("aria-expanded"), overflow:d.documentElement.scrollWidth>w.innerWidth, scripts:$("#thread").querySelectorAll("script,img,svg,iframe,[onclick],[onerror]").length, badLinks:$("#thread").querySelectorAll("a[href^=javascript],a[href^=data]").length };'), { font: "16px", inspector: "none", expanded: "false", overflow: false, scripts: 0, badLinks: 0 });
    assert.deepEqual(await app('return [".transcript",".sidebar",".inspector",".composer",".message.user"].map(s=>w.getComputedStyle($(s)).backgroundColor);'), ["rgb(28, 29, 31)", "rgb(32, 33, 36)", "rgb(32, 33, 36)", "rgb(42, 43, 46)", "rgb(48, 49, 53)"]);
    assert.equal(await app('return w.getComputedStyle($(".message.user"),"::before").display;'), "none");
    await app('$("#message").value="長草稿\\n".repeat(20); $("#message").dispatchEvent(new Event("input",{bubbles:true})); $("#message").focus(); return true;');
    assert.ok(await app('return $("#message").clientHeight<=192 && $("#message").scrollHeight>$("#message").clientHeight;'));
    assert.equal(await app('return d.activeElement.id;'), "message");
    await key("ArrowRight");
    assert.ok(await app('return w.getComputedStyle($("#message")).outlineStyle!=="none";'));
    await app('$("#message").value="保留草稿 / draft"; $("#message").dispatchEvent(new Event("input",{bubbles:true})); $("#transcript").scrollTop=120; $("#toggle-focus").click(); return true;');
    assert.equal(await app('return $("#toggle-focus").getAttribute("aria-pressed");'), "true");
    assert.equal(await app('return w.getComputedStyle($("#conversation-panel")).display;'), "none");
    await key("Escape");
    assert.equal(await app('return $("#toggle-focus").getAttribute("aria-pressed");'), "false");
    assert.equal(await app('return $("#message").value;'), "保留草稿 / draft");
    assert.ok(Math.abs(await app('return $("#transcript").scrollTop;') - 120) < 5, "Focus toggle keeps transcript scroll");
    if (width > 760) {
      await app('$("#open-conversations").click(); return true;');
      assert.equal(await app('return w.getComputedStyle($("#conversation-panel")).display;'), "none");
      await app('$("#open-conversations").click(); return true;');
      assert.equal(await app('return $("#open-conversations").getAttribute("aria-expanded");'), "true");
    } else {
      await app('$("#open-conversations").click(); return true;');
      assert.equal(await app('return $("#conversation-panel").getAttribute("aria-modal");'), "true");
      await app('$("#close-rail").focus(); return true;');
      // Close is not the first focusable element; reverse Tab from the first wraps.
      await app('$("#new-chat").focus(); return true;');
      await key("Tab", 8);
      assert.equal(await app('return $("#conversation-panel").contains(d.activeElement);'), true);
      assert.equal(await app('const nodes=Array.from($("#conversation-panel").querySelectorAll(\'button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]\')).filter(el=>el.getClientRects().length); return d.activeElement===nodes[nodes.length-1];'), true);
      await key("Tab");
      assert.equal(await app('return d.activeElement.id;'), "new-chat");
      await key("Escape");
      assert.equal(await app('return d.activeElement.id;'), "open-conversations");
      assert.equal(await app('return $(".chat").inert;'), false);
    }
    await app('$("#toggle-inspector").click(); return true;');
    assert.equal(await app('return $("#toggle-inspector").getAttribute("aria-expanded");'), "true");
    assert.ok(await app('return $("#workstream").textContent.includes("回合 2");'));
    if (width <= 1080) { assert.equal(await app('return $("#workstream-panel").getAttribute("aria-modal");'), "true"); await key("Escape"); }
    else await app('$("#close-inspector").click(); return true;');
    assert.equal(await app('return d.activeElement.id;'), "toggle-inspector");
    await app('$("#thread-details").open=true; return true;');
    assert.ok(await app('return $("#thread-controls").textContent.includes("tokens");'));
    await app('$("#thread-details").open=false; const users=d.querySelectorAll(".message.user"); users[users.length-1].scrollIntoView({block:"start"}); return true;');
    const shot = await screenshot("workspace-" + width);
    const geometry = await app('const c=$("#composer").getBoundingClientRect();return {bottom:c.bottom,height:w.innerHeight};');
    assert.ok(geometry.bottom <= geometry.height + 1, "Composer remains inside viewport");
    console.log(JSON.stringify({ width, pass: true, screenshot: shot }));
  }
  // Search, errors, exact approval actions, artifacts and status remain reachable.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 893, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  await app('$("#conversation-search").value="歷史對話 22"; $("#conversation-search").dispatchEvent(new Event("input",{bubbles:true})); return true;');
  assert.equal(await app('return d.querySelectorAll(".conversation-item").length;'), 1);
  await app('$("#conversation-search").value=""; $("#conversation-search").dispatchEvent(new Event("input",{bubbles:true})); return true;');
  await evaluate('document.querySelector("#scenario").click()');
  await until('return Boolean($("[data-approval]"));');
  assert.ok(await app('return $("#thread").textContent.includes("離線錯誤");'));
  await app('$("#toggle-focus").click(); return true;');
  assert.ok(await app('return $("[data-approval]").getClientRects().length>0;'));
  await app('$("[data-approval][data-decision=accept]").click(); return true;');
  await until('return !$("[data-approval]");');
  await app('$("#toggle-focus").click(); $("#toggle-inspector").click(); $("[data-result-artifact]").click(); return true;');
  await until('return !$("#artifact").hidden;');
  assert.ok(await app('return $("#artifact-content").textContent.includes("第一輪 UX");'));
  await app('$("#close-artifact").click(); $("#close-inspector").click(); $("#open-operator").click(); return true;');
  await until('return $("#operator-content").textContent.includes("INVALID_RESPONSE");');
  await app('$("#close-operator").click(); $("#toggle-display").click(); return true;');
  await until('return d.body.dataset.displayMode==="inline";');
  assert.equal(await app('return w.getComputedStyle($(".message-body")).fontSize;'), "16px");
  await app('$("#open-conversations").click(); return true;');
  assert.equal(await app('return $("#conversation-panel").getAttribute("aria-modal");'), "true");
  await key("Escape");
  assert.equal(await app('return $("#message").value;'), "保留草稿 / draft");
  } else {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 893, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await send("Page.bringToFront");
    await delay(150);
    await until('return Boolean($(".markdown table") && $("#toggle-focus"));');
    await app('$("#message").value="保留草稿 / draft"; $("#message").dispatchEvent(new Event("input")); return true;');
  }
  // Composer interactions at 390px, using the same context/artifact and send owners.
  await app('if(d.body.dataset.displayMode!=="fullscreen") $("#toggle-display").click(); return true;');
  await until('return d.body.dataset.displayMode==="fullscreen";');
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 893, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  await app('$("#run-settings").open=true; $("#mode").value="plan"; $("#mode").dispatchEvent(new Event("change")); $("#reviewer").value="user"; $("#reviewer").dispatchEvent(new Event("change")); return true;');
  assert.equal(await app('return $("#run-settings-summary").textContent;'), "Plan 唯讀 · 每次詢問");
  await app('$("#run-settings").open=false; $("#toggle-context").click(); return true;');
  await until('return $("#toggle-context").getAttribute("aria-expanded")==="true";');
  assert.equal(await app('return d.activeElement.id;'), "context");
  assert.ok(await app('return $("#composer").getBoundingClientRect().bottom<=w.innerHeight && $("#toggle-context").getBoundingClientRect().right<=$("#send").getBoundingClientRect().left;'));
  await app('$("#context").value="附加背景"; $("#classification").value="public"; $("#classification").dispatchEvent(new Event("change")); $("#add-text-artifact").click(); return true;');
  await until('return d.activeElement.id==="text-entry-content";');
  await app('$("#text-entry-name").value="fixture.txt"; $("#text-entry-content").value="offline attachment"; $("#text-entry-form").requestSubmit(); return true;');
  await until('return $("#text-entry").hidden && $("#draft-artifacts").textContent.includes("fixture.txt") && !$("#send").disabled;');
  await until('return d.activeElement.id==="add-text-artifact";');
  await screenshot("composer-390-attachment");
  await app('$("#toggle-context").click(); $("#message").value="[fixture-error]"; $("#message").dispatchEvent(new Event("input")); $("#message").focus(); $("#message").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true})); return true;');
  assert.equal(await evaluate('window.fixtureCalls.filter(x=>x.name==="codex_conversation_send").length'), 0, "IME Enter never submits");
  await app('$("#send").click(); return true;');
  assert.equal(await app('return $("#send").disabled && $("#send").getAttribute("aria-label")==="處理中";'), true);
  await until('return $("#error-bar").textContent.includes("送出失敗") && !$("#send").disabled;');
  assert.equal(await app('return $("#message").value;'), "[fixture-error]");
  assert.ok(await app('return $("#draft-artifacts").textContent.includes("fixture.txt");'));
  await app('$("#message").value="新版 composer 送出檢查"; $("#message").dispatchEvent(new Event("input")); $("#message").focus(); return true;');
  await key("Enter");
  await until('return !$("#message").value && !$("#send").disabled;');
  assert.ok(await app('return $("#thread").textContent.includes("新版 composer 送出檢查");'));
  const sent = await evaluate('window.fixtureCalls.filter(x=>x.name==="codex_conversation_send").at(-1).args');
  assert.equal(sent.executionMode, "plan"); assert.equal(sent.approvalReviewer, "user"); assert.equal(sent.context, "附加背景"); assert.equal(sent.dataClassification, "public"); assert.deepEqual(sent.inputBundleIds, ["fixture-bundle"]);
  assert.equal(await app('return $("#draft-artifacts").textContent;'), "");
  await until('return $("#message").clientHeight<=52 && d.documentElement.scrollWidth===w.innerWidth;');
  const measurements = await app(`
    const input=$("#message"), rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const textarea={value:input.value,clientHeight:input.clientHeight,scrollHeight:input.scrollHeight,cssHeight:w.getComputedStyle(input).height,rows:input.rows};
    // Measure the old default rows in a detached-from-layout clone, without changing the real editor/cache.
    const clone=input.cloneNode(); clone.removeAttribute("id"); clone.value=""; clone.rows=2; clone.style.cssText="position:absolute;visibility:hidden;height:auto;width:"+input.clientWidth+"px";
    $("#composer").append(clone); const defaultTwoRows={clientHeight:clone.clientHeight,scrollHeight:clone.scrollHeight}; clone.remove();
    $("#run-settings").open=true; const popover=rect($(".settings-popover")); $("#run-settings").open=false;
    return {textarea,defaultTwoRows,htmlScrollWidth:d.documentElement.scrollWidth,viewportWidth:w.innerWidth,toolbar:rect($(".composer-bar")),send:rect($("#send")),popover};
  `);
  console.log(JSON.stringify({ composerMeasurements: measurements }));
  assert.ok(measurements.textarea.clientHeight <= 52);
  assert.equal(measurements.htmlScrollWidth, measurements.viewportWidth);
  assert.ok(measurements.toolbar.left >= 0 && measurements.toolbar.right <= measurements.viewportWidth);
  assert.ok(measurements.popover.left >= 0 && measurements.popover.right <= measurements.viewportWidth);
  await screenshot("composer-390-sent");
  assert.deepEqual(errors, [], "No browser runtime exceptions");
  assert.deepEqual(externalRequests, [], "Fixture/app makes no external requests");
  console.log(JSON.stringify({ pass: true, scenarios: composerOnly ? "composer: focus, attachment, IME, failed/successful send, sizing, toolbar/popover bounds at 390px" : "responsive, keyboard/focus, drafts/scroll, Markdown/XSS, search, errors, approval, artifacts, status, inline, composer", output: run }));
  await send("Browser.close");
} finally {
  socket?.close();
  // Exact child processes owned by this test only; never touch Bridge owners.
  if (browser && browser.exitCode === null) browser.kill();
  if (fixture.exitCode === null) fixture.kill();
}
