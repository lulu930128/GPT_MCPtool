// Existing Chromium + Playwright only; file preview, blocked network, no server.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const [playwrightModule, executablePath, outputDir, baselineDir] = process.argv.slice(2);
if (!outputDir) throw Error("Pass existing Playwright module, Chromium executable and isolated output directory");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const output = await build({ entryPoints: ["scripts/readback-capsules-browser-fixture.tsx"], bundle: true, write: false,
  platform: "browser", format: "iife", loader: { ".css": "text" },
  plugins: baselineDir ? [{ name: "saved-before", setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]DeskOrders\.tsx$/ }, async () => ({ contents: await readFile(path.join(baselineDir, "DeskOrders.tsx.before"), "utf8"), loader: "tsx" }));
    builder.onLoad({ filter: /[\\/]src[\\/]styles\.css$/ }, async () => ({ contents: await readFile(path.join(baselineDir, "styles.css.before"), "utf8"), loader: "text" }));
  } }] : [],
});
await mkdir(outputDir, { recursive: true });
const html = path.resolve(outputDir, "preview.html");
await writeFile(html, `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMI 離線交易顯示驗證</title></head><body><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
const browser = await chromium.launch({ executablePath, headless: true });
const receipts = [];
try {
  for (const width of [320, 375, 390, 650, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } });
    const external = [], errors = [];
    await context.route("**/*", route => {
      if (route.request().url().startsWith("file:")) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(pathToFileURL(html).href);
    const button = name => page.getByRole("button", { name, exact: true });
    const overflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    const screenshot = async name => { await overflow(); await page.screenshot({ path: path.join(outputDir, `${name}-${width}.png`), fullPage: true }); };
    const update = async () => { await button("更新資料").click(); await button("更新資料").waitFor({ state: "visible" }); };
    // Five real components, same navigation and actions, no mutation clicked.
    for (const tab of ["研究預選", "待送單", "券商委託", "成交", "庫存"]) {
      await button(tab).click();
      if (tab === "成交") await button("歷史成交").click();
      await page.waitForTimeout(350);
      await screenshot(tab);
    }
    if (!baselineDir) {
      const stock = page.getByRole("article", { name: "3702 券商庫存", exact: true });
      assert.equal(await stock.isVisible(), true);
      assert.match(await stock.innerText(), /3702 大聯大[\s\S]*1000 股[\s\S]*可出清 1000 股[\s\S]*可下單 1000 股/);
      const zero = page.getByRole("region", { name: "零餘額紀錄", exact: true });
      assert.equal(await zero.locator("details").getAttribute("open"), null);
      assert.equal(await page.getByRole("article", { name: "2637 券商庫存", exact: true }).isVisible(), false);
      await zero.locator("summary").focus(); await page.keyboard.press("Enter");
      await page.getByRole("article", { name: "2637 券商庫存", exact: true }).waitFor({ state: "visible" });
      await stock.locator("summary").click();
      assert.match(await stock.innerText(), /融資[\s\S]*0 股[\s\S]*融券[\s\S]*待回補/);
      await screenshot("庫存展開");
      await page.evaluate(() => window.capsulesFixture.fail(true)); await update();
      assert.match(await page.getByRole("alert").innerText(), /保留上次資料，可能已過期/);
      assert.match(await stock.innerText(), /1000 股/);
      await screenshot("庫存讀取失敗");
      await page.evaluate(() => window.capsulesFixture.reset()); await update();
      await button("成交").click(); await page.waitForTimeout(300);
      for (const symbol of ["2330", "8227"]) {
        const card = page.getByRole("article", { name: `${symbol} 成交`, exact: true });
        assert.equal(await card.count(), 1); assert.equal(await card.locator(".workspace-readback-entry").count(), 2);
        assert.match(await card.innerText(), /現股買進[\s\S]*現股賣出/);
      }
      assert.match(await page.getByRole("article", { name: "2330 成交", exact: true }).innerText(), /2026-11-06[\s\S]*2,140[\s\S]*零股 1 股[\s\S]*2026-11-09[\s\S]*2,240/);
      const unknownFill = await page.getByRole("article", { name: "8227 成交", exact: true }).innerText();
      assert.equal((unknownFill.match(/數量未確認/g) ?? []).length, 2);
      assert.equal((unknownFill.match(/未提供/g) ?? []).length, 2);
      const reads = await page.evaluate(() => window.capsulesFixture.calls.filter(name => name === "omi_read_desk_fills").length);
      await page.getByLabel("成交日期", { exact: true }).fill("2026-11-09");
      assert.equal(await page.locator("#workspace-broker-fills .workspace-readback-entry").count(), 2);
      await button("當日成交").click(); assert.match(await page.locator("#workspace-broker-fills").innerText(), /此範圍尚未讀到成交/);
      await button("歷史成交").click(); await page.getByLabel("成交日期", { exact: true }).fill("");
      assert.equal(await page.evaluate(() => window.capsulesFixture.calls.filter(name => name === "omi_read_desk_fills").length), reads, "scope/date change must not read again");
      await page.evaluate(() => { const api = window.capsulesFixture; const rows = structuredClone(api.initial.fills); rows[0].broker_key.trade_date = null; api.setFills(rows); });
      await update(); assert.match(await page.getByRole("region", { name: "成交日期待核對" }).innerText(), /未提供/);
      await screenshot("成交日期待核對");
      await button("庫存").click();
      for (const scenario of ["all-zero", "unknown", "mixed", "empty", "many-zeros"]) {
        await page.evaluate(scenario => {
          const api = window.capsulesFixture, inventory = structuredClone(api.initial.inventory);
          if (scenario === "all-zero") inventory.cash.items[1] = { ...inventory.cash.items[0], symbol: "3702" };
          if (scenario === "unknown") {
            inventory.cash.items = [{ symbol: "3702", reported_total_shares: 0 }];
            inventory.margin.items = []; inventory.short_selling.items = null; inventory.short_selling.quality = "UNKNOWN";
          }
          if (scenario === "mixed") inventory.margin.items = [{ symbol: "3702", reported_total_shares: 500, closeable_shares: 400, orderable_shares: 300 }];
          if (scenario === "empty") { for (const part of Object.values(inventory)) part.items = []; Object.assign(inventory.margin, { quality: "KNOWN", complete: true, empty_confirmed: true }); }
          if (scenario === "many-zeros") inventory.cash.items = [...Array.from({ length: 500 }, (_, index) => ({ ...inventory.cash.items[0], symbol: `zero-${index}` })), inventory.cash.items[1]];
          api.setInventory(inventory);
        }, scenario);
        await update();
        const text = await page.locator("#workspace-broker-inventory").innerText();
        if (scenario === "all-zero") { assert.match(text, /零餘額紀錄 · 2 檔/); assert.doesNotMatch(text, /已確認此類無持倉/); }
        if (scenario === "unknown") { assert.match(text, /餘額待確認/); assert.match(text, /本次未回傳庫存列，尚不能確認空手/); assert.match(text, /庫存未知，不視為零/); assert.equal(await stock.isVisible(), true); }
        if (scenario === "mixed") { assert.match(await stock.innerText(), /1000 股[\s\S]*500 股/); assert.doesNotMatch(await stock.innerText(), /1500 股/); }
        if (scenario === "empty") { assert.match(text, /本次未回傳庫存列，尚不能確認空手/); assert.match(text, /已確認此類無持倉/); }
        if (scenario === "many-zeros") { assert.match(text, /零餘額紀錄 · 501 檔/); assert.equal(await page.locator("#workspace-broker-inventory .workspace-readback-card").count(), 1); assert.match(await stock.innerText(), /1000 股/); }
        await screenshot(`庫存-${scenario}`);
      }
    }
    const calls = await page.evaluate(() => window.capsulesFixture.calls);
    assert.ok(calls.every(name => /^(omi_read_|omi_list_research_proposals$|omi_search_tw_symbols$)/.test(name)), "no mutations");
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    receipts.push({ width, five_sections: true, baseline: !!baselineDir, no_overflow: true, no_external_io: true, no_mutations: true, calls, errors });
    await writeFile(path.join(outputDir, "receipt.json"), JSON.stringify(receipts, null, 2));
    console.log(`PASS ${baselineDir ? "before" : "capsules"} ${width}px; five sections, no overflow/external IO/mutations`);
    await context.close();
  }
} finally { await browser.close(); }
