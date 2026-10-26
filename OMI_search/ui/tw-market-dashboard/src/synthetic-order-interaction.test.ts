import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("actual panel handlers enforce manual preview/ack/confirm, selection reset, timer expiry and page cleanup without IO", async () => {
  // Same controlled-effects approach as chart-lifecycle.test.ts. This exercises
  // actual component handlers, not browser rendering/accessibility acceptance.
  let cursor = 0, dirty = false, now = 1_000;
  const slots: any[] = [];
  let effects: (() => void)[] = [];
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const hooks = {
    useReducer(reducer: (state: any, action: any) => any, arg: any, init: (arg: any) => any) {
      const index = cursor++;
      slots[index] ??= { value: init(arg) };
      return [slots[index].value, (action: any) => { slots[index].value = reducer(slots[index].value, action); dirty = true; }];
    },
    useEffect(fn: () => (() => void) | undefined, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps[i]))) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() };
      });
    },
  };
  const output = await build({
    entryPoints: [fileURLToPath(new URL("./SyntheticOrderPanel.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    plugins: [{ name: "controlled-panel", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: "controlled" }));
      builder.onLoad({ filter: /.*/, namespace: "controlled" }, (args) => ({ contents: args.path === "react"
        ? "export const {useReducer,useEffect}=globalThis.hooks;"
        : "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';" }));
    } }],
  });
  const module = { exports: {} as any };
  const forbidden = () => { throw new Error("Unexpected external operation"); };
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, hooks,
    Date: class extends Date { static now() { return now; } },
    window: { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name), postMessage: forbidden },
    setInterval: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id: number) => timers.delete(id), fetch: forbidden,
    localStorage: { setItem: forbidden, getItem: forbidden }, sessionStorage: { setItem: forbidden, getItem: forbidden },
  });
  let tree: any, symbol = "2330";
  function render() {
    let count = 0;
    do {
      dirty = false; cursor = 0; effects = [];
      tree = module.exports.SyntheticOrderPanel({ symbol });
      effects.forEach((effect) => effect());
      assert.ok(++count < 10, "component settles after selection invalidation");
    } while (dirty);
  }
  const flatten = (node: any): any[] => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node)
    : node && typeof node === "object" ? [node.props?.children].flat(Infinity).map(text).join("") : "";
  const find = (predicate: (node: any) => boolean) => {
    const node = flatten(tree).find(predicate); assert.ok(node, "expected element exists"); return node;
  };
  const button = (label: string) => find((node) => node.type === "button" && text(node) === label);
  const input = (name: string) => find((node) => node.props?.["aria-label"] === name);
  const change = (name: string, value: string) => { input(name).props.onChange({ target: { value } }); render(); };
  const submit = () => { find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); render(); };
  const fill = () => {
    change("模擬方向", "BUY"); change("模擬委託類型", "LIMIT"); change("模擬交易單位", "BOARD");
    change("模擬股數", "1000"); change("模擬限價", "100");
  };
  const ack = () => { find((node) => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); render(); };
  render();
  assert.equal(tree.props["data-phase"], "editing");
  assert.equal(input("模擬方向").props.value, "");
  submit(); assert.match(text(tree), /請明確選擇 BUY/);
  fill(); submit();
  assert.equal(timers.size, 1);
  assert.equal(button("2. 明確確認本次模擬").props.disabled, true);
  ack(); assert.equal(button("2. 明確確認本次模擬").props.disabled, false);
  change("模擬限價", "99");
  assert.equal(timers.size, 0);
  assert.equal(tree.props["data-phase"], "editing");
  submit(); ack();
  const oldConfirm = button("2. 明確確認本次模擬").props.onClick;
  oldConfirm(); oldConfirm(); render();
  assert.equal(tree.props["data-phase"], "receipt");
  assert.match(text(tree), /SIMULATED_PENDING/);
  assert.match(text(tree), /模擬次數 1/);
  assert.equal(timers.size, 0);
  button("提出模擬取消意圖").props.onClick(); render();
  assert.match(text(tree), /CANCEL_PENDING/);
  button("播放下一筆 fixture 回報").props.onClick(); render();
  assert.match(text(tree), /SIMULATED_CANCELLED/);
  symbol = "0050"; render();
  assert.equal(input("模擬方向").props.value, "");
  assert.doesNotMatch(text(tree), /SIMULATED_PENDING/);
  fill(); submit(); ack();
  now += 60_000; [...timers.values()].forEach((timer) => timer()); render();
  assert.equal(tree.props["data-phase"], "expired");
  assert.equal(timers.size, 0);
  submit(); ack();
  listeners.get("pagehide")!(); render();
  listeners.get("pageshow")!(); render();
  assert.equal(input("模擬股數").props.value, "");
  assert.equal(tree.props["data-phase"], "editing");
  fill(); submit();
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
});
