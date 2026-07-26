import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HubApiError,
  JapaneseStudyHubClient,
  type RecordAttemptInput,
  type SearchItemsInput,
  type SetManualLabelInput,
} from "./api-client.js";
import type { JapaneseStudyMcpConfig } from "./config.js";

const kindSchema = z.enum(["vocab", "grammar", "question"]);
const labelSchema = z.enum(["known", "unknown", "uncertain", "suspended"]);
const attemptResultSchema = z.enum(["seen", "correct", "wrong", "easy", "again"]);

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const retrySafeWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export function createJapaneseStudyMcpServer(config: JapaneseStudyMcpConfig): McpServer {
  const client = new JapaneseStudyHubClient(config);
  const server = new McpServer(
    { name: "japanese-study-mcp", version: "0.1.0" },
    {
      instructions:
        "Private Japanese study tools backed by Japanese Study Hub. Search or get a study plan before mutating progress. Use exact stable item ids for labels and attempts. Do not infer an id from an ambiguous title. Reuse the same eventId when retrying one attempt. This server has no delete, reset, file, SQL, shell, Anki-write, or legacy-migration tools.",
    },
  );

  server.registerTool(
    "study_get_summary",
    {
      title: "取得日文學習摘要",
      description:
        "Use this when the user asks for current Japanese study totals, manual-label counts, or attempt counts without modifying progress.",
      annotations: readOnlyAnnotations,
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        summary: z.record(z.unknown()),
      },
    },
    async () => safeResult(() => client.summary(), "已取得日文學習摘要。"),
  );

  server.registerTool(
    "study_search_items",
    {
      title: "搜尋日文學習項目",
      description:
        "Use this when the user wants to find vocabulary, grammar, or questions and obtain exact stable item ids before another action.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        query: z.string().max(200).optional().describe("Word, reading, or Traditional Chinese meaning."),
        kind: kindSchema.optional().describe("Optional item type filter."),
        jlptLevel: z.string().max(20).optional().describe("Optional JLPT level such as N3."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum matches. Defaults to 20."),
      },
      outputSchema: {
        ok: z.boolean(),
        count: z.number().int().nonnegative(),
        items: z.array(z.record(z.unknown())),
      },
    },
    async (args) =>
      safeResult(
        () => client.searchItems(args as SearchItemsInput),
        "已完成日文學習項目搜尋。",
      ),
  );

  server.registerTool(
    "study_get_item",
    {
      title: "取得單一學習項目",
      description:
        "Use this when an exact stable study item id is already known and the user needs its current content, manual label, and attempt evidence.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128).describe("Exact stable item id returned by search or a study plan."),
      },
      outputSchema: {
        ok: z.boolean(),
        item: z.record(z.unknown()),
      },
    },
    async ({ itemId }) => safeResult(() => client.getItem(itemId), "已取得指定學習項目。"),
  );

  server.registerTool(
    "study_get_plan",
    {
      title: "取得今日學習計畫",
      description:
        "Use this when the user wants a bounded prioritized list for Japanese study or review without changing any progress.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        kind: kindSchema.optional().describe("Optional item type filter."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum items. Defaults to 20."),
      },
      outputSchema: {
        ok: z.boolean(),
        count: z.number().int().nonnegative(),
        items: z.array(z.record(z.unknown())),
      },
    },
    async (args) => safeResult(() => client.studyPlan(args), "已取得優先學習項目。"),
  );

  server.registerTool(
    "study_set_manual_labels",
    {
      title: "設定人工熟悉度分類",
      description:
        "Use this when the user explicitly wants exact study item ids marked as known, unknown, uncertain, or suspended. Repeating the same labels is safe.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        labels: z
          .array(
            z.object({
              itemId: z.string().min(1).max(128),
              label: labelSchema,
              note: z.string().max(1000).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      outputSchema: {
        ok: z.boolean(),
        result: z.record(z.unknown()),
      },
    },
    async ({ labels }) =>
      safeResult(
        () => client.setManualLabels(labels as SetManualLabelInput[]),
        "已更新人工熟悉度分類。",
      ),
  );

  server.registerTool(
    "study_record_attempt",
    {
      title: "記錄一次答題結果",
      description:
        "Use this when the user has completed one exact study item attempt. eventId must uniquely identify that attempt and must be reused on retry.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        eventId: z.string().min(8).max(128).describe("Caller-generated idempotency id for this one attempt."),
        itemId: z.string().min(1).max(128).describe("Exact stable study item id."),
        result: attemptResultSchema,
        occurredAt: z.string().datetime().optional(),
        sessionId: z.string().max(128).optional(),
        metadata: z.record(z.unknown()).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        result: z.record(z.unknown()),
      },
    },
    async (args) =>
      safeResult(
        () => client.recordAttempt(args as RecordAttemptInput),
        "已記錄答題結果；相同 eventId 的重試不會重複計入。",
      ),
  );

  return server;
}

async function safeResult(read: () => Promise<unknown>, message: string) {
  try {
    const value = await read();
    return {
      structuredContent: asObject(value),
      content: [{ type: "text" as const, text: message }],
    };
  } catch (error) {
    const details = error instanceof HubApiError ? ` (${error.status})` : "";
    const messageText = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Japanese Study Hub error${details}: ${messageText}` }],
    };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubApiError("Japanese Study Hub returned an invalid object response.", 502);
  }
  return value as Record<string, unknown>;
}
