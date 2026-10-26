import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const workspace = css.slice(css.indexOf("/* Progressive workspace"), css.indexOf("* { box-sizing"));

test("compact metric and market grids align values without clipping or iframe-relative sizing", () => {
  assert.match(workspace, /\.workspace-metrics-grid \{ display: grid;[^}]*repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\)/);
  assert.match(workspace, /\.workspace-metric \{[^}]*grid-template-columns: minmax\(0, 1fr\) fit-content\(70%\)/);
  assert.match(workspace, /\.workspace-metric dd \{[^}]*text-align: right;[^}]*font-variant-numeric: tabular-nums/);
  assert.doesNotMatch(workspace.match(/\.workspace-metric dd \{[^}]*\}/)?.[0] ?? "", /hidden|ellipsis|nowrap/);
  assert.match(workspace, /\.workspace-index-value \{[^}]*text-align: right/);
  assert.match(workspace, /\.workspace-market-breadth dd \{[^}]*text-align: right/);
  assert.match(workspace, /max-width: 450px[\s\S]*?workspace-market-breadth \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(workspace, /workspace-up \{ color: var\(--up\)/);
  assert.match(workspace, /workspace-down \{ color: var\(--down\)/);
});

test("every workspace display mode has no iframe viewport-height dependency or hidden document scroll", () => {
  // Scan the whole workspace cascade, not just min-height:100vh (the old guard).
  assert.doesNotMatch(workspace, /\b\d*\.?\d+(?:[dsl]?vh|vb|vmin|vmax)\b/i);
  assert.doesNotMatch(workspace, /@media[^{}]*(?:height|aspect-ratio)/i);
  assert.doesNotMatch(workspace, /(?:innerHeight|maxHeight)\s*[:=]/);
  assert.match(css, /html\[data-omi-workspace="true"\] body \{ overflow: visible; \}/);
  assert.match(css, /html\[data-omi-workspace="true"\] \{ scrollbar-gutter: stable; \}/);
  assert.doesNotMatch(workspace, /\.(?:tw-workspace|workspace-columns|workspace-watchlist)\s*\{[^}]*overflow[^:]*:\s*(?:hidden|clip)/);
  assert.doesNotMatch(workspace, /overscroll-behavior[^:]*:\s*(?:contain|none)/);
  assert.doesNotMatch(workspace, /\.workspace-watchlist\s*\{[^}]*position:\s*(?:sticky|fixed)/);
  const source = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(source, /data-display-mode=\{presentation.actualDisplayMode\}/);
  assert.doesNotMatch(source, /presentation\.(?:viewportHeight|maxHeight)/);
});

// Deliberately a MOCK host geometry model, not a browser CSS engine. The CSS
// contract above excludes other viewport-dependent inputs. Read the actual
// pixel bounds below so changes cannot silently leave this model's bounds stale.
const sidebar = Number(workspace.match(/\.workspace-watchlist \{ height: (\d+)px;/)![1]);
const tree = Number(workspace.match(/\.workspace-group-scroll \{ height: (\d+)px;/)![1]);
function rounds(layout: (height: number) => number, initial: number) {
  const heights = [initial];
  for (let round = 0; round < 20; round++) heights.push(layout(heights.at(-1)!));
  return heights;
}

test("mock host negative control reproduces the old sticky height positive feedback", () => {
  // Header/footer/padding outside the sidebar exceed its 76px subtraction.
  // This is an explicit host/layout assumption, not a measured ChatGPT height.
  const old = rounds((height) => 128 + Math.max(650, height >= 700 ? height - 76 : Math.min(.65 * height, 680) + 260), 699);
  assert.ok(old.every((height, i) => i === 0 || height > old[i - 1]));
  assert.ok(old.at(-1)! > 1700);
});

for (const width of [1440, 1150, 650, 390]) {
  test(`mock auto-resizing host converges across modes/content and short hosts at ${width}px`, () => {
    // Synthetic intrinsic content changes represent initialization, search,
    // selection, expansion and polling. They may resize once, never recurse.
    for (const mode of ["unknown", "inline", "pip", "fullscreen", "inline"]) {
      for (const content of [0, 280, 760, 4000, 760]) {
        const sidebarHeight = width > 650 ? sidebar : tree + Math.min(content, 240) + 200;
        const rightHeight = content > 0 ? 900 : 620;
        const documentHeight = 128 + (width > 650 ? Math.max(sidebarHeight, rightHeight) : sidebarHeight + rightHeight);
        for (const initial of [180, 699, 700, 1100, 12000]) {
          const history = rounds(() => documentHeight, initial);
          assert.equal(new Set(history.slice(1)).size, 1, `${mode}, content ${content}, initial ${initial}`);
          assert.ok(history.at(-1)! <= 2000);
          assert.ok(history.slice(2).every((height, i) => height === history[i + 1]));
        }
      }
    }
    assert.ok(sidebar <= 900 && tree >= 300 && tree <= 500);
  });
}
