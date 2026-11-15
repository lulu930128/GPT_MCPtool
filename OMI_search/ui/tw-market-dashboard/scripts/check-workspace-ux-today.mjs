import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const [playwrightModule, browserPath, outputDir] = process.argv.slice(2);
if (!outputDir) throw Error("Explicit existing Playwright module, browser executable and isolated artifact directory required");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const bundle = await build({ entryPoints: ["scripts/workspace-ux-today-fixture.tsx"], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" } });
await mkdir(outputDir, { recursive: true });
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMI Offline Workspace UX</title></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await writeFile(path.join(outputDir, "fixture.html"), html, "utf8");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const results = [];
let currentPage, currentWidth;
try {
  for (const width of [390, 650, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", route => route.request().url().startsWith("file:") ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    currentPage = page; currentWidth = width;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(pathToFileURL(path.join(outputDir, "fixture.html")).href);
    assert.equal(await page.evaluate(() => window.isSecureContext && typeof crypto.randomUUID === "function"), true);
    await writeFile(path.join(outputDir, `startup-${width}.json`), JSON.stringify({ url: page.url(), title: await page.title(), text: await page.locator("body").innerText(), errors }), "utf8");
    const click = name => page.getByRole("button", { name, exact: true }).filter({ visible: true }).click();
    if (width < 1248) await click("交易");
    for (let n = 1; n <= 3; n++) {
      await page.getByLabel("委託價格", { exact: true }).fill("80");
      await page.getByLabel("委託數量").fill("1");
      await click("加入掛單");
      const card = page.locator(`#stage-offline-stage-${n}`);
      await card.waitFor({ state: "visible", timeout: 5000 }).catch(async error => {
        await writeFile(path.join(outputDir, `failure-${width}.txt`), await page.locator("body").innerText() + "\n" + JSON.stringify({ errors, calls: await page.evaluate(() => window.uxFixture.calls) }), "utf8");
        await page.screenshot({ path: path.join(outputDir, `failure-${width}.png`), fullPage: true }); throw error;
      });
      await page.waitForFunction(id => document.activeElement?.id === id, `stage-offline-stage-${n}`);
      assert.equal(await page.locator("main").getAttribute("data-workspace-view"), "trade");
      await click("繼續新增委託");
      await page.getByLabel("委託數量").fill("1");
      assert.equal(await page.getByText("無法加入掛單", { exact: false }).count(), 0);
    }
    await page.evaluate(() => window.uxFixture.setMode("timeout"));
    await click("加入掛單");
    await page.locator("#stage-offline-stage-4").waitFor({ state: "visible" });
    await click("繼續新增委託");
    await page.getByLabel("委託數量").fill("1");
    await page.evaluate(() => window.uxFixture.setMode("timeout-held"));
    await click("加入掛單");
    await page.getByRole("button", { name: "待確認 · 請讀回", exact: true }).waitFor();
    await click("待送單");
    assert.equal(await page.locator("#stage-offline-stage-1").getByRole("button", { name: "修改", exact: true }).isEnabled(), true);
    await click("新增委託");
    await page.evaluate(() => window.uxFixture.recover("SUBMITTED"));
    await click("讀回原意圖（不重送）");
    await page.locator("#stage-offline-stage-5").waitFor({ state: "visible" });
    assert.equal(await page.locator("#stage-offline-stage-5").getByRole("button", { name: "送單", exact: true }).count(), 0);
    await click("新增委託");
    assert.equal(await page.getByText("已讀回原委託：已送出。", { exact: true }).first().isVisible(), true);
    await click("研究預選");
    await click("加入待送單");
    await page.locator("#stage-offline-stage-6").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "stage-offline-stage-6");
    // The G3 checks above still use the exact backend receipt codec. Complete
    // workspace checks now use typed backend chart/header/research fixtures.
    const a = page.locator("#stage-offline-stage-1"), b = page.locator("#stage-offline-stage-2");
    await a.getByRole("button", { name: "修改", exact: true }).click();
    assert.equal(await a.getByRole("form", { name: "修改本地待送單" }).count(), 1);
    assert.equal(await b.getByLabel("修改價格").count(), 0);
    assert.equal(await b.getByRole("button", { name: "刪除", exact: true }).isEnabled(), true);
    await a.getByLabel("修改價格").fill("81");
    await page.screenshot({ path: path.join(outputDir, `inline-edit-${width}.png`), fullPage: true });
    await click("券商委託");
    assert.equal(await page.getByRole("form", { name: "修改本地待送單" }).isVisible(), false);
    await click("待送單"); await a.getByRole("button", { name: "儲存修改" }).click();
    await a.getByRole("form", { name: "修改本地待送單" }).waitFor({ state: "hidden" });
    assert.match(await a.innerText(), /81/);
    const researchBefore = await page.evaluate(() => window.uxFixture.calls.filter(c => c.name === "omi_read_tw_stock_research").length);
    await a.locator("summary").getByText("技術摘要", { exact: true }).click();
    await a.getByText(/收盤 101 在 20 日均線之上/).waitFor();
    await b.locator("summary").getByText("技術摘要", { exact: true }).click();
    await b.getByText(/日線背景 · 截至 2026-11-11/).waitFor();
    assert.equal(await page.evaluate(() => window.uxFixture.calls.filter(c => c.name === "omi_read_tw_stock_research").length), researchBefore + 1, "no per-card preload or duplicate same-symbol read");
    await page.evaluate(() => window.uxFixture.setMode("success"));
    for (const [condition, side, id] of [["融資", "賣出", 7], ["融券", "買進", 8]]) {
      await click("繼續新增委託"); await click(condition); await click(side);
      await page.getByLabel("委託價格", { exact: true }).fill("80"); await page.getByLabel("委託數量").fill("1");
      await click("加入掛單"); await page.locator(`#stage-offline-stage-${id}`).waitFor({ state: "visible" });
      const request = await page.evaluate(() => window.uxFixture.calls.filter(c => c.name === "omi_create_desk_draft").at(-1).args);
      assert.equal(Object.hasOwn(request, "protection"), false, "credit close creates no reverse protection");
    }
    await page.evaluate(() => window.uxFixture.linkToBroker()); await click("券商委託");
    await page.locator("#stage-offline-stage-8").getByRole("button", { name: "前往此筆券商委託" }).click();
    await page.waitForFunction(() => document.activeElement?.id === "broker-execution-fixture-active");
    assert.equal(await page.getByRole("region", { name: "跨日待核對委託", exact: true }).isVisible(), true);
    await page.screenshot({ path: path.join(outputDir, `broker-${width}.png`), fullPage: true });
    await click("成交"); await page.getByText("當日成交fixture", { exact: false }).waitFor();
    assert.equal(await page.getByText("歷史成交fixture", { exact: false }).count(), 0);
    await click("歷史成交"); await page.getByLabel("成交日期", { exact: true }).fill("2026-11-11");
    await page.getByText("歷史成交fixture", { exact: false }).waitFor();
    assert.equal(await page.getByText("當日成交fixture", { exact: false }).count(), 0);
    await click("庫存"); await page.getByText("庫存未知，不視為零", { exact: true }).first().waitFor();
    assert.match(await page.getByRole("region", { name: "現股券商庫存", exact: true }).innerText(), /1,?000/);
    await page.screenshot({ path: path.join(outputDir, `inventory-${width}.png`), fullPage: true });
    if (width < 1248) await click("看圖");
    await click("今日"); await page.getByText(/今日 2026-11-12 · missing/).waitFor();
    assert.match(await page.getByRole("region", { name: "圖表技術摘要" }).innerText(), /無可用摘要/);
    assert.doesNotMatch(await page.locator(".workspace-technical-pane").innerText(), /昨日資料不得充當今日盤中結論/);
    await page.screenshot({ path: path.join(outputDir, `today-missing-${width}.png`), fullPage: true });
    await click("查看上一交易日 2026-11-11");
    await page.getByText(/上一交易日 2026-11-11 · 歷史快取/).waitFor();
    assert.match(await page.getByRole("region", { name: "圖表技術摘要" }).innerText(), /不套用當日均線或研究/);
    await click("返回今日");
    await page.evaluate(() => window.uxFixture.setChart("today_partial")); await click("日 K"); await click("今日");
    await page.getByText(/75\/86 根/).waitFor();
    await page.screenshot({ path: path.join(outputDir, `today-partial-${width}.png`), fullPage: true });
    await click("日 K"); await page.getByText(/盤中暫定，截至.*10:15.*延遲/).waitFor();
    assert.match(await page.getByRole("region", { name: "圖表技術摘要" }).innerText(), /暫定 K 棒不套用完成均線/);
    await page.screenshot({ path: path.join(outputDir, `daily-provisional-${width}.png`), fullPage: true });
    await page.evaluate(() => window.uxFixture.setChart("stale_quote")); await click("今日"); await click("日 K");
    await page.getByText(/盤中暫定，截至.*09:30.*延遲/).waitFor();
    await page.evaluate(() => window.uxFixture.setChart("final")); await click("今日"); await click("日 K");
    await page.getByText(/已完成至 2026-11-11/).waitFor();
    assert.equal(await page.getByText(/盤中暫定，截至/).count(), 0);
    if (width < 1248) await click("交易");
    await click("待送單");
    if (width === 390) for (const delay of [1000, 5000, 20000]) {
      await page.evaluate(value => window.uxFixture.setBrokerDelay(value), delay);
      const start = await page.evaluate(() => ({ count: window.uxFixture.brokerCompleted, reads: window.uxFixture.calls.filter(c => c.name === "omi_read_desk_orders").length }));
      await click("券商委託"); await click("待送單");
      await a.getByRole("button", { name: "修改", exact: true }).waitFor({ state: "visible", timeout: 1500 });
      assert.equal(await a.getByRole("button", { name: "修改", exact: true }).isEnabled(), true);
      await click("券商委託");
      await page.waitForFunction(count => window.uxFixture.brokerCompleted > count, start.count, { timeout: delay + 10000 });
      assert.equal(await page.evaluate(() => window.uxFixture.calls.filter(c => c.name === "omi_read_desk_orders").length), start.reads + 1);
      await page.evaluate(() => window.uxFixture.setBrokerDelay(0)); await click("待送單");
    }
    const calls = await page.evaluate(() => window.uxFixture.calls);
    assert.equal(calls.filter(call => call.name === "omi_create_desk_draft").length, 7);
    assert.equal(new Set(calls.filter(call => call.name === "omi_create_desk_draft").map(call => call.args.client_intent_id)).size, 7);
    assert.equal(calls.filter(call => /confirm|approve|cancel_desk/.test(call.name)).length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    const visibleText = await page.locator("body").innerText();
    assert.doesNotMatch(visibleText, /讀取失敗|資料格式不符|本地已送紀錄；狀態依券商讀回|操作已有回應|成交歷史尚不完整，僅列已知成交/);
    await page.screenshot({ path: path.join(outputDir, `full-workspace-${width}.png`), fullPage: true });
    results.push({ width, status: "PASS", localCreates: 7, researchCreates: 1, brokerMutations: 0, inlineEdit: true, cardResearch: "on-demand shared", chartCases: ["missing", "previous", "partial", "provisional-prefix", "provisional-stale-quote", "final"], latencyMs: width === 390 ? [1000, 5000, 20000] : [], errors });
    await context.close();
  }
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(outputDir, `failure-${currentWidth}.png`), fullPage: true });
    await writeFile(path.join(outputDir, `failure-${currentWidth}.txt`), await currentPage.locator("body").innerText() + "\n" + String(error), "utf8");
  }
  await writeFile(path.join(outputDir, "results.json"), JSON.stringify([...results, { width: currentWidth, status: "FAIL", error: String(error) }], null, 2), "utf8");
  throw error;
} finally { await browser.close(); }
await writeFile(path.join(outputDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
console.log(JSON.stringify(results));
