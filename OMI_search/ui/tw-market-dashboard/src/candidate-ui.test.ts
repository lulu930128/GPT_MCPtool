import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CandidatePanel } from "./CandidatePanel";
import { WorkspaceContext } from "./WorkspaceContext";
import { readFileSync } from "node:fs";

const bridge = { async callTool(): Promise<never> { throw new Error("Render must not perform IO"); } };

test("Workspace keeps one candidate panel mounted behind conditional mode and separates broker pages", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceContext, { bridge, symbol: "2330" }));
  assert.doesNotMatch(html, /SYNTHETIC|workspace-research-content/);
  assert.match(html, /aria-controls="workspace-candidate-content"/);
  assert.match(html, /id="workspace-candidate-content" hidden=""/);
  assert.equal((html.match(/class="candidate-panel"/g) ?? []).length, 1);
  for (const page of ["trade", "orders", "fills", "inventory"]) assert.ok(html.includes(`id="workspace-broker-${page}"`));
  assert.match(html, /尚無可驗證的即時報價/);
  const source = readFileSync(new URL("./WorkspaceContext.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SyntheticOrderPanel|synthetic-ticket/);
});

test("candidate homepage is a compact filtered list without a form or expanded diagnostics", () => {
  const html = renderToStaticMarkup(createElement(CandidatePanel, { bridge, symbol: "3481", active: false }));
  for (const label of ["目前股票 3481", "全部", "尚未取得候選清單", "＋ 新增", "提醒 0 項"]) assert.ok(html.includes(label), label);
  assert.match(html, /data-view="list"/); assert.match(html, /data-symbol="3481"/);
  assert.doesNotMatch(html, /<form|<textarea|<input|PENDING_APPROVAL|NATIVE_PREVIEW|已成交/);
  assert.doesNotMatch(html, /class="candidate-reminders" open/);
});

test("approved matte palette is Workspace scoped with narrow controls and reduced motion", () => {
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  for (const color of ["#0c1118", "#151d27", "#1c2632", "#dbe3ec", "#93a1af", "#87aeb8"]) assert.ok(styles.includes(color), color);
  assert.match(styles, /\.tw-workspace \{[^}]*--bg: #0c1118/);
  const workspace = styles.slice(styles.indexOf("/* Progressive workspace"), styles.indexOf("* { box-sizing"));
  assert.doesNotMatch(workspace, /backdrop-filter/); assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /@media \(max-width: 650px\) \{\s*\.candidate-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
});
