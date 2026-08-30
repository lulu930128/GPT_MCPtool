import { createHash } from "node:crypto";
import { redactString } from "./redaction.js";
import type {
  ConversationFreshness,
  ConversationItemProjection,
  ConversationMessage,
  ConversationThreadProjection,
  ConversationTurnProjection,
} from "./types.js";

const MAX_MESSAGE_CHARS = 100_000;
const MAX_ACTIVITY_TEXT_CHARS = 20_000;
const MAX_FILE_DIFF_CHARS = 8_000;

export interface ConversationNotification {
  method: string;
  params?: Record<string, unknown>;
}

export function createConversationProjection(threadId?: string, at = new Date().toISOString()): ConversationThreadProjection {
  return {
    schemaVersion: 1,
    threadId,
    status: "unknown",
    turns: [],
    revision: 0,
    updatedAt: at,
  };
}

export function hydrateConversationProjection(
  current: ConversationThreadProjection,
  response: Record<string, unknown>,
  at = new Date().toISOString(),
  freshness?: ConversationFreshness,
): ConversationThreadProjection {
  const thread = isObject(response.thread) ? response.thread : response;
  const threadId = stringValue(thread.id) ?? current.threadId;
  const hydratedTurns = Array.isArray(thread.turns)
    ? thread.turns.flatMap((turn) => isObject(turn) ? [normalizeTurn(turn, at)] : [])
    : [];
  const currentTurns = new Map(current.turns.map((turn) => [turn.turnId, turn]));
  const merged = hydratedTurns.map((turn) => mergeHydratedTurn(currentTurns.get(turn.turnId), turn));
  return {
    schemaVersion: 1,
    threadId,
    status: threadStatus(thread.status) ?? current.status,
    turns: merged,
    revision: current.revision + 1,
    updatedAt: at,
    hydratedAt: at,
    freshness: freshness ? structuredClone(freshness) : current.freshness,
  };
}

export function reduceConversationNotification(
  current: ConversationThreadProjection,
  notification: ConversationNotification,
  at = new Date().toISOString(),
): ConversationThreadProjection {
  const next = structuredClone(current);
  const params = notification.params ?? {};
  next.threadId = stringValue(params.threadId) ?? nestedId(params, "thread") ?? next.threadId;

  if (notification.method === "thread/status/changed") {
    next.status = threadStatus(params.status) ?? next.status;
    return changed(next, at);
  }
  if (notification.method === "turn/started") {
    const rawTurn = isObject(params.turn) ? params.turn : params;
    const turnId = stringValue(rawTurn.id) ?? stringValue(params.turnId);
    if (turnId) upsertTurn(next, normalizeTurn({ ...rawTurn, id: turnId }, at));
    next.status = "active";
    return changed(next, at);
  }
  if (notification.method === "turn/completed") {
    const rawTurn = isObject(params.turn) ? params.turn : params;
    const turnId = stringValue(rawTurn.id) ?? stringValue(params.turnId);
    if (turnId) {
      const normalized = normalizeTurn({ ...rawTurn, id: turnId }, at);
      const turn = upsertTurn(next, normalized);
      turn.status = stringValue(rawTurn.status) ?? "completed";
      turn.completedAt = timestamp(rawTurn.completedAt) ?? at;
      turn.durationMs = numberValue(rawTurn.durationMs) ?? turn.durationMs;
      for (const item of turn.items) {
        if (!item.isStreaming) continue;
        item.isStreaming = false;
        item.status = turn.status === "completed" ? "completed" : turn.status;
        item.updatedAt = at;
        delete item.lastDelta;
      }
    }
    next.status = "idle";
    return changed(next, at);
  }

  const turnId = stringValue(params.turnId) ?? nestedId(params, "turn");
  if (!turnId) return current;
  const turn = ensureTurn(next, turnId, at);

  if (notification.method === "bridge/approval") {
    const itemId = stringValue(params.itemId) ?? `approval:${stringValue(params.approvalId) ?? turnId}`;
    const existing = turn.items.find((item) => item.id === itemId);
    const item = existing ?? ensureItem(turn, itemId, "approval", at);
    item.approvalId = stringValue(params.approvalId) ?? item.approvalId;
    item.approvalState = approvalState(params.state) ?? item.approvalState;
    item.status = item.approvalState ?? item.status;
    item.isStreaming = item.approvalState === "pending";
    item.activityType = existing ? item.activityType : stringValue(params.kind) ?? "approval";
    item.updatedAt = at;
    return changed(next, at);
  }

  if (notification.method === "item/started" || notification.method === "item/completed") {
    const rawItem = isObject(params.item) ? params.item : params;
    const phase = notification.method === "item/completed" ? "completed" : "started";
    const item = normalizeItem(rawItem, turnId, phase, at);
    if (item) upsertItem(turn, item, phase === "completed");
    return changed(next, at);
  }

  const itemId = stringValue(params.itemId);
  if (notification.method === "item/agentMessage/delta" && itemId) {
    appendDelta(turn, itemId, "agentMessage", stringValue(params.delta) ?? "", at, MAX_MESSAGE_CHARS);
    return changed(next, at);
  }
  if (notification.method === "item/plan/delta" && itemId) {
    appendDelta(turn, itemId, "plan", stringValue(params.delta) ?? "", at, MAX_MESSAGE_CHARS);
    return changed(next, at);
  }
  if (notification.method === "item/reasoning/summaryTextDelta" && itemId) {
    appendDelta(turn, itemId, "reasoningSummary", stringValue(params.delta) ?? "", at, MAX_ACTIVITY_TEXT_CHARS);
    return changed(next, at);
  }
  if (notification.method === "item/commandExecution/outputDelta" && itemId) {
    const item = ensureItem(turn, itemId, "commandExecution", at);
    appendItemOutput(item, stringValue(params.delta) ?? "", at);
    return changed(next, at);
  }
  if (notification.method === "item/fileChange/patchUpdated" && itemId) {
    const item = ensureItem(turn, itemId, "fileChange", at);
    item.status = "inProgress";
    item.isStreaming = true;
    item.changes = normalizeChanges(params.changes);
    item.updatedAt = at;
    return changed(next, at);
  }
  if (notification.method === "item/mcpToolCall/progress" && itemId) {
    const item = ensureItem(turn, itemId, "mcpToolCall", at);
    item.status = "inProgress";
    item.isStreaming = true;
    item.progress = bounded(stringValue(params.message) ?? "", MAX_ACTIVITY_TEXT_CHARS);
    item.updatedAt = at;
    return changed(next, at);
  }
  if (notification.method === "turn/diff/updated") {
    const item = ensureItem(turn, `diff:${turnId}`, "diff", at);
    item.status = "inProgress";
    item.isStreaming = true;
    item.text = bounded(stringValue(params.diff) ?? stringValue(params.unifiedDiff) ?? "", MAX_ACTIVITY_TEXT_CHARS);
    item.updatedAt = at;
    return changed(next, at);
  }
  if (notification.method === "error") {
    const message = errorText(params);
    const id = `error:${turnId}:${createHash("sha256").update(message).digest("hex").slice(0, 16)}`;
    upsertItem(turn, {
      id,
      turnId,
      type: "error",
      status: "failed",
      text: bounded(message, MAX_ACTIVITY_TEXT_CHARS),
      isStreaming: false,
      createdAt: at,
      updatedAt: at,
    }, true);
    return changed(next, at);
  }

  return current;
}

export function mergeConversationMessages(
  projection: ConversationThreadProjection,
  messages: ConversationMessage[],
): ConversationThreadProjection {
  const next = structuredClone(projection);
  const projectedItems = flattenItems(next);
  const projectedUsersByClientId = new Map(
    projectedItems
      .filter((item) => item.type === "userMessage" && item.clientMessageId)
      .map((item) => [item.clientMessageId!, item]),
  );
  const matchedMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user" || !message.clientMessageId) continue;
    const item = projectedUsersByClientId.get(message.clientMessageId);
    if (!item) continue;
    matchedMessageIds.add(message.id);
    item.context = message.context ? bounded(message.context, MAX_MESSAGE_CHARS) : undefined;
    item.inputArtifacts = structuredClone(message.inputArtifacts ?? []);
    item.clientMessageId = message.clientMessageId;
  }

  // Once App Server history has synchronized successfully, it is authoritative.
  // Unmatched Bridge records may carry metadata, but must not recreate source-deleted
  // messages or overwrite source text by ordinal position.
  if (next.freshness?.synchronized) return next;

  for (const message of messages) {
    if (matchedMessageIds.has(message.id)) continue;
    const projectedType = message.role === "user" ? "userMessage" : "agentMessage";
    const sameTurnItem = message.turnId
      ? projectedItems.some((item) => item.turnId === message.turnId && item.type === projectedType)
      : undefined;
    if (sameTurnItem) continue;
    const turnId = message.turnId ?? `local:${message.id}`;
    const turn = ensureTurn(next, turnId, message.at);
    upsertItem(turn, {
      id: `bridge-message:${message.id}`,
      turnId,
      type: message.role === "user" ? "userMessage" : "agentMessage",
      status: message.resultStatus ?? "completed",
      text: bounded(message.content, MAX_MESSAGE_CHARS),
      context: message.context ? bounded(message.context, MAX_MESSAGE_CHARS) : undefined,
      isStreaming: false,
      createdAt: message.at,
      updatedAt: message.at,
      clientMessageId: message.clientMessageId,
      inputArtifacts: structuredClone(message.inputArtifacts ?? []),
    }, true);
  }
  return next;
}

function normalizeTurn(raw: Record<string, unknown>, at: string): ConversationTurnProjection {
  const turnId = stringValue(raw.id) ?? stringValue(raw.turnId) ?? `unknown:${at}`;
  return {
    turnId,
    status: stringValue(raw.status) ?? "unknown",
    items: Array.isArray(raw.items)
      ? raw.items.flatMap((item) => {
          if (!isObject(item)) return [];
          const normalized = normalizeItem(item, turnId, "hydrated", at);
          return normalized ? [normalized] : [];
        })
      : [],
    startedAt: timestamp(raw.startedAt),
    completedAt: timestamp(raw.completedAt),
    durationMs: numberValue(raw.durationMs),
  };
}

function normalizeItem(
  raw: Record<string, unknown>,
  turnId: string,
  phase: "started" | "completed" | "hydrated",
  at: string,
): ConversationItemProjection | undefined {
  const rawType = stringValue(raw.type);
  const id = stringValue(raw.id);
  if (!rawType || !id) return undefined;
  const completed = phase !== "started";
  const base: ConversationItemProjection = {
    id,
    turnId,
    type: projectionType(rawType),
    status: stringValue(raw.status) ?? (completed ? "completed" : "inProgress"),
    isStreaming: !completed,
    createdAt: at,
    updatedAt: at,
  };
  if (rawType === "userMessage") {
    base.text = bounded(userInputText(raw.content), MAX_MESSAGE_CHARS);
    base.clientMessageId = stringValue(raw.clientId);
  } else if (rawType === "agentMessage" || rawType === "plan") {
    base.text = bounded(stringValue(raw.text) ?? "", MAX_MESSAGE_CHARS);
  } else if (rawType === "reasoning") {
    base.type = "reasoningSummary";
    base.text = bounded(stringArray(raw.summary).join("\n\n"), MAX_ACTIVITY_TEXT_CHARS);
    if (!base.text) return undefined;
  } else if (rawType === "commandExecution") {
    base.command = bounded(stringValue(raw.command) ?? "", MAX_ACTIVITY_TEXT_CHARS);
    base.cwd = bounded(stringValue(raw.cwd) ?? "", 2_000);
    base.output = bounded(stringValue(raw.aggregatedOutput) ?? "", MAX_ACTIVITY_TEXT_CHARS);
    base.outputTruncated = (stringValue(raw.aggregatedOutput)?.length ?? 0) > MAX_ACTIVITY_TEXT_CHARS;
    base.exitCode = numberValue(raw.exitCode);
    base.durationMs = numberValue(raw.durationMs);
  } else if (rawType === "fileChange") {
    base.changes = normalizeChanges(raw.changes);
  } else if (rawType === "mcpToolCall") {
    base.server = bounded(stringValue(raw.server) ?? "", 500);
    base.tool = bounded(stringValue(raw.tool) ?? "", 500);
    base.durationMs = numberValue(raw.durationMs);
    if (isObject(raw.error)) base.error = bounded(stringValue(raw.error.message) ?? "Tool call failed.", 2_000);
  } else {
    base.activityType = rawType;
    base.durationMs = numberValue(raw.durationMs);
  }
  return base;
}

function mergeTurn(current: ConversationTurnProjection | undefined, hydrated: ConversationTurnProjection): ConversationTurnProjection {
  if (!current) return hydrated;
  const hydratedItems = new Map(hydrated.items.map((item) => [item.id, item]));
  const items = hydrated.items.map((item) => mergeItem(current.items.find((candidate) => candidate.id === item.id), item, true));
  for (const item of current.items) if (!hydratedItems.has(item.id)) items.push(structuredClone(item));
  return {
    turnId: hydrated.turnId,
    status: hydrated.status === "unknown" ? current.status : hydrated.status,
    items,
    startedAt: hydrated.startedAt ?? current.startedAt,
    completedAt: hydrated.completedAt ?? current.completedAt,
    durationMs: hydrated.durationMs ?? current.durationMs,
  };
}

function mergeHydratedTurn(
  current: ConversationTurnProjection | undefined,
  hydrated: ConversationTurnProjection,
): ConversationTurnProjection {
  if (!current) return hydrated;
  return {
    turnId: hydrated.turnId,
    status: hydrated.status === "unknown" ? current.status : hydrated.status,
    items: hydrated.items.map((item) => mergeItem(
      current.items.find((candidate) => candidate.id === item.id),
      item,
      true,
    )),
    startedAt: hydrated.startedAt ?? current.startedAt,
    completedAt: hydrated.completedAt ?? current.completedAt,
    durationMs: hydrated.durationMs ?? current.durationMs,
  };
}

function upsertTurn(projection: ConversationThreadProjection, incoming: ConversationTurnProjection): ConversationTurnProjection {
  const index = projection.turns.findIndex((turn) => turn.turnId === incoming.turnId);
  if (index < 0) {
    projection.turns.push(incoming);
    return incoming;
  }
  const merged = mergeTurn(projection.turns[index], incoming);
  projection.turns[index] = merged;
  return merged;
}

function ensureTurn(projection: ConversationThreadProjection, turnId: string, at: string): ConversationTurnProjection {
  let turn = projection.turns.find((candidate) => candidate.turnId === turnId);
  if (!turn) {
    turn = { turnId, status: "inProgress", items: [], startedAt: at };
    projection.turns.push(turn);
  }
  return turn;
}

function upsertItem(turn: ConversationTurnProjection, incoming: ConversationItemProjection, authoritative: boolean): ConversationItemProjection {
  const index = turn.items.findIndex((item) => item.id === incoming.id);
  if (index < 0) {
    turn.items.push(incoming);
    return incoming;
  }
  const merged = mergeItem(turn.items[index], incoming, authoritative);
  turn.items[index] = merged;
  return merged;
}

function mergeItem(current: ConversationItemProjection | undefined, incoming: ConversationItemProjection, authoritative: boolean): ConversationItemProjection {
  if (!current || authoritative) {
    return {
      ...(current ?? {}),
      ...incoming,
      createdAt: current?.createdAt ?? incoming.createdAt,
      isStreaming: authoritative ? false : incoming.isStreaming,
      lastDelta: authoritative ? undefined : incoming.lastDelta,
    };
  }
  return { ...current, ...incoming, createdAt: current.createdAt ?? incoming.createdAt };
}

function ensureItem(
  turn: ConversationTurnProjection,
  itemId: string,
  type: ConversationItemProjection["type"],
  at: string,
): ConversationItemProjection {
  const existing = turn.items.find((item) => item.id === itemId);
  if (existing) return existing;
  const item: ConversationItemProjection = {
    id: itemId,
    turnId: turn.turnId,
    type,
    status: "inProgress",
    isStreaming: true,
    createdAt: at,
    updatedAt: at,
  };
  turn.items.push(item);
  return item;
}

function appendDelta(
  turn: ConversationTurnProjection,
  itemId: string,
  type: ConversationItemProjection["type"],
  delta: string,
  at: string,
  maxChars: number,
): void {
  if (!delta) return;
  const item = ensureItem(turn, itemId, type, at);
  if (item.lastDelta === delta) return;
  item.text = bounded(`${item.text ?? ""}${delta}`, maxChars);
  item.lastDelta = delta;
  item.status = "inProgress";
  item.isStreaming = true;
  item.updatedAt = at;
}

function appendItemOutput(item: ConversationItemProjection, delta: string, at: string): void {
  if (!delta || item.lastDelta === delta) return;
  const combined = `${item.output ?? ""}${delta}`;
  item.output = bounded(combined, MAX_ACTIVITY_TEXT_CHARS);
  item.outputTruncated = combined.length > MAX_ACTIVITY_TEXT_CHARS || item.outputTruncated === true;
  item.lastDelta = delta;
  item.status = "inProgress";
  item.isStreaming = true;
  item.updatedAt = at;
}

function normalizeChanges(value: unknown): ConversationItemProjection["changes"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((change) => {
    if (!isObject(change)) return [];
    const path = stringValue(change.path) ?? stringValue(change.filePath);
    if (!path) return [];
    const diff = stringValue(change.diff) ?? "";
    return [{
      path: bounded(path, 2_000),
      kind: stringValue(change.kind) ?? "update",
      diffPreview: bounded(diff, MAX_FILE_DIFF_CHARS),
      diffTruncated: diff.length > MAX_FILE_DIFF_CHARS,
    }];
  });
}

function flattenItems(projection: ConversationThreadProjection): ConversationItemProjection[] {
  return projection.turns.flatMap((turn) => turn.items);
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((input) => {
    if (!isObject(input)) return [];
    if (input.type === "text") return [stringValue(input.text) ?? ""];
    if (input.type === "skill" || input.type === "mention") return [`@${stringValue(input.name) ?? input.type}`];
    if (["image", "localImage", "audio", "localAudio"].includes(String(input.type))) return [`[${String(input.type)}]`];
    return [];
  }).filter(Boolean).join("\n");
}

function projectionType(rawType: string): ConversationItemProjection["type"] {
  if (["userMessage", "agentMessage", "plan", "commandExecution", "fileChange", "mcpToolCall"].includes(rawType)) {
    return rawType as ConversationItemProjection["type"];
  }
  if (rawType === "reasoning") return "reasoningSummary";
  return "activity";
}

function approvalState(value: unknown): ConversationItemProjection["approvalState"] {
  return ["pending", "accepted", "declined", "cancelled", "expired"].includes(String(value))
    ? value as ConversationItemProjection["approvalState"]
    : undefined;
}

function errorText(params: Record<string, unknown>): string {
  if (isObject(params.error)) return stringValue(params.error.message) ?? "Codex reported an error.";
  return stringValue(params.message) ?? "Codex reported an error.";
}

function threadStatus(value: unknown): ConversationThreadProjection["status"] | undefined {
  const raw = isObject(value) ? stringValue(value.type) : stringValue(value);
  if (!raw) return undefined;
  if (raw === "active") return "active";
  if (raw === "idle") return "idle";
  if (raw === "systemError") return "systemError";
  if (raw === "notLoaded") return "notLoaded";
  return "unknown";
}

function changed(projection: ConversationThreadProjection, at: string): ConversationThreadProjection {
  projection.revision += 1;
  projection.updatedAt = at;
  return projection;
}

function bounded(value: string, maxChars: number): string {
  const redacted = redactString(value);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[truncated]` : redacted;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1_000).toISOString();
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedId(value: Record<string, unknown>, key: string): string | undefined {
  return isObject(value[key]) ? stringValue(value[key].id) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
