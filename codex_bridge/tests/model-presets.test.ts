import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PRESETS, modelPresetCatalog, resolveModelSelection } from "../src/model-presets.js";
import { previewWorkPackage } from "../src/work-package.js";

test("Bridge presets contain exactly the requested pairs, with no implicit default or coercion", () => {
  assert.deepEqual(MODEL_PRESETS.map(({ model, effort }) => [model, effort]), [
    ["gpt-6.2-astra", "high"], ["gpt-6.2-sol", "high"], ["gpt-6.2-sol", "medium"],
  ]);
  for (const preset of MODEL_PRESETS) {
    const pair = { model: preset.model, effort: preset.effort };
    assert.deepEqual(resolveModelSelection({ modelPreset: preset.id }), pair);
    assert.deepEqual(resolveModelSelection(pair), pair);
    const preview = previewWorkPackage({ projectId: "test", title: "Preset", objective: "Inspect", ...resolveModelSelection({ modelPreset: preset.id }) });
    assert.equal(preview.workPackage.model, preset.model); assert.equal(preview.workPackage.effort, preset.effort);
    assert.equal(preview.workPackage.speed, "standard");
  }
  for (const input of [{}, { model: "gpt-6.2-astra" }, { effort: "medium" as const },
    { model: "gpt-5.6-sol", effort: "medium" as const }, { model: "gpt-6.2-astra", effort: "medium" as const },
    { modelPreset: "gpt-6.2-sol/xhigh" }, { modelPreset: "gpt-6.2-sol/high", effort: "medium" as const },
    { modelPreset: "gpt-6.2-sol/medium", model: "gpt-6.2-astra" },
    { modelPreset: "gpt-6.2-sol/medium", modelSelection: "custom" as const }, { modelSelection: "custom" as const },
  ]) assert.throws(() => resolveModelSelection(input));
  assert.deepEqual(resolveModelSelection({}, true), {}, "Omitted continuation leaves inheritance to the controller");
  assert.throws(() => resolveModelSelection({ effort: "medium" }, true), /exact/);
  assert.deepEqual(resolveModelSelection({ modelSelection: "custom", model: " Vendor/Old.ID ", effort: "ultra" }), { model: "Vendor/Old.ID", effort: "ultra" });
});

test("retired fixed presets and pairs are rejected without substitution", () => {
  for (const [model, effort] of [["gpt-6-astra", "xhigh"], ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "medium"]] as const) {
    assert.throws(() => resolveModelSelection({ modelPreset: `${model}/${effort}` }), /Unknown modelPreset/);
    assert.throws(() => resolveModelSelection({ model, effort }), /exact modelPreset/);
  }
});

test("preset availability is separate from native model/list and never asserts executed support", () => {
  const models = [{ id: "gpt-6-astra", displayName: "Astra", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "xhigh" as const }] },
    { id: "gpt-5.6-sol", displayName: "Old Sol", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" as const }] }];
  const before = structuredClone(models);
  assert.ok(modelPresetCatalog(models).every((p) => p.availability === "NOT VERIFIED"), "Legacy inventory does not verify 6.2");
  assert.deepEqual(models, before);
  assert.ok(modelPresetCatalog(undefined).every((p) => p.availability === "NOT VERIFIED"));
  assert.ok(modelPresetCatalog([]).every((p) => p.availability === "NOT VERIFIED"));
  assert.deepEqual(modelPresetCatalog([...models,
    { id: "gpt-6.2-astra", displayName: "Fixture Astra", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    { id: "gpt-6.2-sol", displayName: "Fixture Sol", isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }]).map((p) => p.availability), ["NATIVE LISTED", "UNAVAILABLE", "NATIVE LISTED"]);
});
