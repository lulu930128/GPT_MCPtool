import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexUserInput, buildInitialTurnUserInput } from "../src/conversation-input.js";
import { previewWorkPackage } from "../src/work-package.js";

const BRIDGE_PROMPT_PATTERNS = [
  /Perform the following work package/i,
  /The bridge selected execution mode/i,
  /Follow repository AGENTS\.md instructions/i,
  /Do not commit, push, publish/i,
  /Run proportionate validation/i,
  /Bridge safety requirements/i,
  /Explain what was verified/i,
];

test("initial turn preserves an exact plain user message", () => {
  const preview = previewWorkPackage({
    projectId: "omi",
    title: "Greeting",
    objective: "hello",
    acceptanceCriteria: [],
    constraints: [],
  });

  assert.equal(buildInitialTurnUserInput(preview.workPackage, []), "hello");
});

test("follow-up input contains only explicit user-authored sections", () => {
  const plain = buildCodexUserInput({ message: "please continue" });
  assert.equal(plain, "please continue");

  const structured = buildCodexUserInput({
    message: "please continue",
    context: "The failing test is controller.test.ts.",
    acceptanceCriteria: ["Keep the existing response shape."],
    constraints: ["Do not change unrelated files."],
  });
  assert.match(structured, /\[USER_CONTEXT\]\nThe failing test/);
  assert.match(structured, /\[USER_ACCEPTANCE_CRITERIA\]\n1\. Keep the existing response shape/);
  assert.match(structured, /\[USER_CONSTRAINTS\]\n1\. Do not change unrelated files/);
  for (const pattern of BRIDGE_PROMPT_PATTERNS) assert.doesNotMatch(structured, pattern);
});

test("text artifact envelope contains data without Bridge behavior instructions", () => {
  const text = buildCodexUserInput({
    message: "Review the attached draft.",
    artifacts: [{
      id: "11111111-1111-1111-1111-111111111111",
      fileName: "engineering_spec.txt",
      mimeType: "text/plain",
      sha256: "a".repeat(64),
      chars: 12,
      bytes: 12,
      content: "draft content",
      localPath: "C:\\safe\\engineering_spec.txt",
    }],
  });

  assert.match(text, /\[ATTACHED_TEXT_ARTIFACT\]/);
  assert.match(text, /engineering_spec\.txt/);
  assert.match(text, /draft content/);
  assert.match(text, /C:\\\\safe\\\\engineering_spec\.txt/);
  for (const pattern of BRIDGE_PROMPT_PATTERNS) assert.doesNotMatch(text, pattern);
  assert.doesNotMatch(text, /read this file|must obey|treat .* as authority|do not modify/i);
});
