import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("single parent header separates native keyboard buttons, preserves selection and reopens ancestors", async () => {
  // Exercise real branch handlers/effects; layout and native key activation still
  // require the browser fixture, not this controlled React hook harness.
  let cursor = 0, dirty = false;
  const slots: any[] = [];
  let effects: (() => void)[] = [];
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (value: any) => {
        slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
        dirty = true;
      }];
    },
    useEffect(fn: () => void, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps[i]))) {
        effects.push(() => { slots[index] = { deps }; fn(); });
      }
    },
  };
  const output = await build({
    entryPoints: [fileURLToPath(new URL("./workspace-navigation.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    plugins: [{ name: "controlled-navigation", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: "controlled" }));
      builder.onLoad({ filter: /.*/, namespace: "controlled" }, (args) => ({ contents: args.path === "react"
        ? "export const {useState,useEffect,useRef,useMemo}=globalThis.hooks;"
        : "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';" }));
    } }],
  });
  const module = { exports: {} as any };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks });
  const leaf = { groupId: 45, groupName: "半導體製造／晶圓代工", children: [] };
  let selected = 45;
  let node = { groupId: 1, groupName: "科技／電子", children: [leaf] };
  let path = [1, 45];
  let chosen = 0;
  let tree: any;
  function render() {
    let iterations = 0;
    do {
      dirty = false; cursor = 0; effects = [];
      tree = module.exports.GroupBranch({ node, selected, path, select: (id: number) => { chosen = id; }, inline: "INLINE" });
      effects.forEach((effect) => effect());
      assert.ok(++iterations < 5);
    } while (dirty);
  }
  const header = () => tree.props.children[0];
  const toggle = () => header().props.children[0];
  const name = () => header().props.children[1];
  render();
  assert.equal(toggle().type, "button");
  assert.equal(name().type, "button");
  for (const button of [toggle(), name()]) {
    assert.equal(button.props.type, "button");
    assert.equal(button.props.tabIndex, undefined, "native tab order is retained");
    assert.equal(button.props.onKeyDown, undefined, "native Enter/Space activation is retained");
  }
  assert.equal(toggle().props["aria-expanded"], true);
  assert.equal(toggle().props["aria-controls"], "workspace-group-children-1");
  assert.equal(tree.props.children[2].props.hidden, false);
  name().props.onClick();
  assert.equal(chosen, 1);
  toggle().props.onClick(); render();
  assert.equal(toggle().props["aria-expanded"], false);
  assert.equal(tree.props.children[2].props.hidden, true);
  assert.equal(chosen, 1, "expansion does not select another group");
  selected = 46; path = [1, 46]; render();
  assert.equal(toggle().props["aria-expanded"], true, "changed selection opens ancestors");
  node = { ...leaf, children: [] }; selected = 45; path = [1, 45]; render();
  assert.equal(toggle().type, "span", "leaf has no empty expansion target");
  assert.equal(name().props["aria-pressed"], true);
  assert.equal(tree.props.children[1], "INLINE");
  name().props.onClick();
  assert.equal(chosen, 45);
});
