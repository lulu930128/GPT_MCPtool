import assert from "node:assert/strict";
import test from "node:test";
import { previewWorkPackage } from "../src/work-package.js";
import { redactString, sanitizeForStorage } from "../src/redaction.js";

test("preview normalizes work packages and produces a stable digest", () => {
  const first = previewWorkPackage({
    projectId: "omi",
    title: "  Check breadth  ",
    objective: "Inspect the current value.   ",
    executionMode: "workspace_write",
    dataClassification: "company_approved",
  });
  const second = previewWorkPackage({
    projectId: "omi",
    title: "Check breadth",
    objective: "Inspect the current value.",
    executionMode: "workspace_write",
    dataClassification: "company_approved",
  });

  assert.equal(first.previewDigest, second.previewDigest);
  assert.equal(first.workPackage.title, "Check breadth");
  assert.equal(first.workPackage.approvalReviewer, "auto_review");
  assert.equal(first.warnings.length, 2);
});

test("preview rejects an unsupported approval reviewer", () => {
  assert.throws(() => previewWorkPackage({
    projectId: "omi",
    title: "Reviewer",
    objective: "Validate reviewer selection.",
    approvalReviewer: "always_allow" as "user",
  }), /Unsupported approvalReviewer/);
});

test("redaction hides secret-bearing keys and values", () => {
  const fakeSecret = ["sk", "fixture".repeat(4)].join("-");
  const sanitized = sanitizeForStorage({
    authorization: "Bearer abcdefghijklmnop",
    command: "run API_TOKEN=super-secret-value",
    nested: { apiKey: fakeSecret },
  }) as Record<string, unknown>;

  assert.equal(sanitized.authorization, "[redacted]");
  assert.match(String(sanitized.command), /\[redacted\]/);
  assert.equal((sanitized.nested as Record<string, unknown>).apiKey, "[redacted]");
  assert.doesNotMatch(redactString("Bearer abcdefghijklmnop"), /abcdefghijklmnop/);
});
