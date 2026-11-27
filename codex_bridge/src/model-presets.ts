import type { CodexModelOption, ReasoningEffort } from "./types.js";

// Bridge choices, not a provider catalog. Never merge these into model/list.
export const MODEL_PRESETS = [
  { id: "gpt-6.2-astra/high", model: "gpt-6.2-astra", effort: "high", reason: "複雜、跨模組或高風險工程工作" },
  { id: "gpt-6.2-sol/high", model: "gpt-6.2-sol", effort: "high", reason: "需要深入推理的聚焦實作或除錯" },
  { id: "gpt-6.2-sol/medium", model: "gpt-6.2-sol", effort: "medium", reason: "範圍明確的一般修改、查詢或整理" },
] as const;

export const MODEL_PRESET_IDS = MODEL_PRESETS.map(({ id }) => id) as [
  typeof MODEL_PRESETS[number]["id"], ...Array<typeof MODEL_PRESETS[number]["id"]>,
];

export const MODEL_SELECTION_GUIDANCE =
  `Choose one exact modelPreset deliberately: ${MODEL_PRESETS.map(({ id }) => id).join(", ")}. ` +
  "Use Astra high for complex cross-module/high-risk work, Sol high for focused deep reasoning, Sol medium for bounded routine work; these are selection guidelines, not availability or performance claims. " +
  "Never auto-default every task to Astra. Unlisted presets are NOT VERIFIED; native App Server decides availability. No fallback or automatic resend. " +
  "For direct conversation continuation or active steering omit all selection fields to inherit. " +
  "Advanced/manual compatibility only: modelSelection=custom with an explicit model ID; this is outside the fixed presets.";

interface ModelSelectionInput {
  modelPreset?: string;
  modelSelection?: "custom";
  model?: string;
  effort?: ReasoningEffort;
}

/** Normalize only new submissions. Stored jobs and historic selections are never rewritten. */
export function resolveModelSelection(input: ModelSelectionInput, allowOmitted = false): { model?: string; effort?: ReasoningEffort } {
  if (input.modelPreset !== undefined) {
    const preset = MODEL_PRESETS.find(({ id }) => id === input.modelPreset);
    if (!preset) throw new Error("Unknown modelPreset. Choose one of: " + MODEL_PRESET_IDS.join(", "));
    if (input.modelSelection || (input.model !== undefined && input.model.trim() !== preset.model) ||
      (input.effort !== undefined && input.effort !== preset.effort)) {
      throw new Error("modelPreset conflicts with model/effort or custom selection. Submit the exact preset pair.");
    }
    return { model: preset.model, effort: preset.effort };
  }
  if (input.modelSelection === "custom") {
    if (!input.model?.trim() || input.model.trim().length > 120) throw new Error("Custom selection requires an explicit model ID (1-120 characters).");
    return { model: input.model.trim(), effort: input.effort };
  }
  if (allowOmitted && input.model === undefined && input.effort === undefined) return {};
  const preset = MODEL_PRESETS.find(({ model, effort }) => model === input.model?.trim() && effort === input.effort);
  if (!preset) throw new Error("Select an exact modelPreset or matching model AND effort: " + MODEL_PRESET_IDS.join(", ") + ". Advanced manual IDs require modelSelection=custom.");
  return { model: preset.model, effort: preset.effort };
}

export function modelPresetCatalog(models: readonly CodexModelOption[] | undefined) {
  return MODEL_PRESETS.map((preset) => {
    const native = models?.find(({ id }) => id === preset.model);
    const availability = !native ? "NOT VERIFIED" as const
      : native.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === preset.effort)
        ? "NATIVE LISTED" as const : "UNAVAILABLE" as const;
    return { ...preset, availability, availabilityReason: !models ? "無法讀取 native 模型清單"
      : !native ? "native 清單未列出模型；僅嘗試指定 ID，不會替換"
        : availability === "UNAVAILABLE" ? "native 清單未列出此推理強度"
          : "native 清單已列出配對；執行與帳號授權尚未驗證" };
  });
}
