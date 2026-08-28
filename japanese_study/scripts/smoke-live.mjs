import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.JSTUDY_MCP_URL || "http://127.0.0.1:18790/mcp");
assert.ok(
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1",
  "smoke:live only connects to a loopback MCP endpoint",
);

const expectedTools = [
  "study_add_study_list_items",
  "study_apply_item_lifecycle",
  "study_apply_item_revision",
  "study_apply_practice_target_overrides",
  "study_create_item",
  "study_create_study_list",
  "study_get_due_reviews",
  "study_get_diagnosis_catalog",
  "study_get_item",
  "study_get_learner_policy",
  "study_get_learning_context",
  "study_get_plan",
  "study_get_practice_session",
  "study_get_quality_inbox",
  "study_get_summary",
  "study_list_practice_sessions",
  "study_list_study_lists",
  "study_preview_item_creation",
  "study_preview_item_lifecycle",
  "study_preview_item_revision",
  "study_preview_practice_record",
  "study_preview_practice_target_resolution",
  "study_preview_question_candidates",
  "study_preview_target_resolution",
  "study_promote_question_candidate",
  "study_record_attempt",
  "study_record_practice",
  "study_record_practice_revision",
  "study_retire_question_candidate",
  "study_save_question_candidate",
  "study_search_items",
  "study_set_manual_labels",
  "study_set_learner_policy",
  "study_supersede_practice_session",
].sort();

const client = new Client({ name: "japanese-study-live-smoke", version: "1.2.1" });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, expectedTools);
  const practiceTool = tools.tools.find((tool) => tool.name === "study_record_practice");
  const diagnosisEvents = practiceTool?.inputSchema?.properties?.questions?.items
    ?.properties?.response?.properties?.diagnosisEvents;
  assert.equal(diagnosisEvents?.items?.type, "object");
  assert.equal(diagnosisEvents?.items?.properties?.code?.type, "string");
  assert.equal(diagnosisEvents?.items?.$ref, undefined);

  const summary = await client.callTool({ name: "study_get_summary", arguments: {} });
  assert.notEqual(summary.isError, true, JSON.stringify(summary.content));
  assert.equal(summary.structuredContent?.ok, true);
  assert.ok(Number(summary.structuredContent?.summary?.items?.total) > 0);
  assert.ok(Number(summary.structuredContent?.summary?.single_attempt_events) >= 0);
  assert.ok(Number(summary.structuredContent?.summary?.practice?.effective_practice_evidence) >= 0);

  const policy = await client.callTool({
    name: "study_get_learner_policy",
    arguments: {},
  });
  assert.notEqual(policy.isError, true, JSON.stringify(policy.content));
  assert.equal(policy.structuredContent?.ok, true);
  assert.equal(policy.structuredContent?.contract_version, "learner-policy-v1");
  assert.equal(
    policy.structuredContent?.policy?.answer_notation?.chinese_parentheses,
    "production_gap",
  );

  const context = await client.callTool({
    name: "study_get_learning_context",
    arguments: {
      requestedLevel: "N4_N3_BRIDGE",
      targetLevels: ["N4", "N3"],
      targetLimit: 3,
      recentSessionLimit: 2,
      diagnosisLimit: 3,
    },
  });
  assert.notEqual(context.isError, true, JSON.stringify(context.content));
  assert.equal(context.structuredContent?.ok, true);
  assert.equal(context.structuredContent?.contract_version, "learning-context-v3");
  assert.ok((context.structuredContent?.recommended_targets?.length ?? 0) <= 3);
  assert.ok((context.structuredContent?.recent_practice?.length ?? 0) <= 2);
  assert.ok((context.structuredContent?.recent_diagnoses?.length ?? 0) <= 3);
  assert.ok(Array.isArray(context.structuredContent?.active_weaknesses));
  assert.ok(Array.isArray(context.structuredContent?.recent_strengths));
  assert.ok(Array.isArray(context.structuredContent?.recent_observations));
  assert.deepEqual(context.structuredContent?.level_scope, {
    practice_profile: "N4_N3_BRIDGE",
    target_levels: ["N4", "N3"],
    source: "explicit",
  });
  assert.equal(context.structuredContent?.generation_guidance?.generator, "ai");
  for (const target of context.structuredContent?.recommended_targets ?? []) {
    assert.ok(
      ["canonical", "proposal_requires_review", "missing"].includes(target.content_status),
    );
    assert.ok(Array.isArray(target.components));
  }

  const defaultContext = await client.callTool({
    name: "study_get_learning_context",
    arguments: {
      requestedLevel: "N4_N3_BRIDGE",
      targetLimit: 20,
      recentSessionLimit: 1,
      diagnosisLimit: 1,
    },
  });
  assert.notEqual(defaultContext.isError, true, JSON.stringify(defaultContext.content));
  assert.deepEqual(defaultContext.structuredContent?.level_scope, {
    practice_profile: "N4_N3_BRIDGE",
    target_levels: ["N4", "N3"],
    source: "profile_default",
  });
  assert.ok(
    (defaultContext.structuredContent?.recommended_targets ?? []).every((target) =>
      ["N4", "N3"].includes(target.jlpt_level),
    ),
  );

  const diagnosisCatalog = await client.callTool({
    name: "study_get_diagnosis_catalog",
    arguments: { query: "particle", active: true, limit: 10 },
  });
  assert.notEqual(diagnosisCatalog.isError, true, JSON.stringify(diagnosisCatalog.content));
  assert.equal(diagnosisCatalog.structuredContent?.contract_version, "diagnosis-catalog-v1");
  assert.ok((diagnosisCatalog.structuredContent?.items?.length ?? 0) <= 10);
  assert.ok(
    diagnosisCatalog.structuredContent?.items?.some(
      (definition) => definition.code === "particle_ga_wo_confusion",
    ),
  );

  const componentItem = await client.callTool({
    name: "study_get_item",
    arguments: { itemId: "vocab:72cb42bb9164773afa341d92" },
  });
  assert.notEqual(componentItem.isError, true, JSON.stringify(componentItem.content));
  assert.equal(componentItem.structuredContent?.ok, true);
  assert.ok((componentItem.structuredContent?.item?.components?.length ?? 0) >= 2);
  assert.ok(
    componentItem.structuredContent?.item?.components?.every(
      (component) => component.status === "verified",
    ),
  );

  const proposalItem = await client.callTool({
    name: "study_get_item",
    arguments: { itemId: "grammar:00649a4a40f93a93066f48f7" },
  });
  assert.notEqual(proposalItem.isError, true, JSON.stringify(proposalItem.content));
  assert.equal(proposalItem.structuredContent?.item?.meaning_tc, "");
  assert.equal(
    proposalItem.structuredContent?.item?.meaning_tc_proposal_status,
    "proposed",
  );
  assert.ok(proposalItem.structuredContent?.item?.meaning_tc_proposal?.length > 0);

  const due = await client.callTool({
    name: "study_get_due_reviews",
    arguments: { limit: 3 },
  });
  assert.notEqual(due.isError, true, JSON.stringify(due.content));
  assert.equal(due.structuredContent?.ok, true);
  assert.ok(Number(due.structuredContent?.count) >= 0);

  const quality = await client.callTool({
    name: "study_get_quality_inbox",
    arguments: { limit: 3 },
  });
  assert.notEqual(quality.isError, true, JSON.stringify(quality.content));
  assert.equal(quality.structuredContent?.ok, true);
  assert.ok(Number(quality.structuredContent?.total) >= 0);

  const lists = await client.callTool({
    name: "study_list_study_lists",
    arguments: { limit: 3 },
  });
  assert.notEqual(lists.isError, true, JSON.stringify(lists.content));
  assert.equal(lists.structuredContent?.ok, true);
  assert.ok(Number(lists.structuredContent?.count) >= 0);

  const creationPreview = await client.callTool({
    name: "study_preview_item_creation",
    arguments: {
      draft: {
        kind: "vocab",
        title: "検証専用未保存語彙",
        reading: "けんしょうせんようみほぞんごい",
        meaningTc: "僅供唯讀 smoke test 預覽，不會儲存",
        tags: ["smoke-preview"],
        provenance: "manual",
        addToInbox: false,
      },
    },
  });
  assert.notEqual(creationPreview.isError, true, JSON.stringify(creationPreview.content));
  assert.equal(creationPreview.structuredContent?.ok, true);
  assert.match(creationPreview.structuredContent?.fingerprint ?? "", /^[0-9a-f]{64}$/);

  const missingSession = await client.callTool({
    name: "study_get_practice_session",
    arguments: { sessionId: "live-smoke-missing-session" },
  });
  assert.equal(missingSession.isError, true);
  assert.equal(missingSession.structuredContent?.error?.code, "PRACTICE_SESSION_NOT_FOUND");
  assert.equal(missingSession.structuredContent?.error?.status, 404);
  assert.equal(missingSession.structuredContent?.error?.retryable, false);

  console.log(JSON.stringify({
    ok: true,
    url: url.toString(),
    toolCount: names.length,
    items: summary.structuredContent.summary.items.total,
    effectivePracticeEvidence:
      summary.structuredContent.summary.practice.effective_practice_evidence,
    policyVersion: policy.structuredContent.version,
    contextTargets: context.structuredContent.recommended_targets.length,
    contextDiagnoses: context.structuredContent.recent_diagnoses.length,
    activeWeaknesses: context.structuredContent.active_weaknesses.length,
    defaultProfileTargets: defaultContext.structuredContent.recommended_targets.length,
    diagnosisDefinitions: diagnosisCatalog.structuredContent.items.length,
    dueReturned: due.structuredContent.count,
    qualityTotal: quality.structuredContent.total,
    listsReturned: lists.structuredContent.count,
    creationPreviewCanCreate: creationPreview.structuredContent.can_create,
    missingSessionError: missingSession.structuredContent.error.code,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
