export type UnknownRecord = Record<string, unknown>;

export interface DashboardSnapshot extends UnknownRecord {
  kind: "omi.tw_market_dashboard";
  version: "omi.tw_market_dashboard.v1";
  snapshot_id: string;
  state_version: number;
  trade_date: string;
  as_of: string | null;
  session: UnknownRecord;
  indices: UnknownRecord[];
  breadth: Record<string, UnknownRecord>;
  hot_groups: UnknownRecord[];
  watchlist: UnknownRecord;
  freshness: UnknownRecord;
  warnings: string[];
  limitations: string[];
}

export interface DashboardScope {
  watchlistGroupId: number | null;
}

export interface WatchlistGroupNode {
  groupId: number;
  groupName: string;
  parentId: number | null;
  sortOrder: number;
  directItemCount: number | null;
  subtreeItemCount: number | null;
  children: WatchlistGroupNode[];
}

export interface WatchlistItemBatch {
  groupId: number;
  items: UnknownRecord[];
  truncated: boolean;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDashboard(value: unknown): DashboardSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== "omi.tw_market_dashboard" ||
    value.version !== "omi.tw_market_dashboard.v1" ||
    typeof value.snapshot_id !== "string" ||
    typeof value.state_version !== "number" ||
    !Number.isFinite(value.state_version) ||
    typeof value.trade_date !== "string" ||
    !isRecord(value.session) ||
    !Array.isArray(value.indices) ||
    !isRecord(value.breadth) ||
    !Array.isArray(value.hot_groups) ||
    !isRecord(value.watchlist) ||
    !isRecord(value.freshness) ||
    !Array.isArray(value.warnings) ||
    !Array.isArray(value.limitations)
  ) {
    return null;
  }
  return value as DashboardSnapshot;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function compareWatchlistGroups(
  left: WatchlistGroupNode,
  right: WatchlistGroupNode,
): number {
  return left.sortOrder - right.sortOrder || left.groupId - right.groupId;
}

export function buildWatchlistTree(value: unknown): WatchlistGroupNode[] {
  if (!Array.isArray(value)) return [];

  const groups = new Map<number, WatchlistGroupNode>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const groupId = positiveInteger(item.group_id);
    const groupName = typeof item.group_name === "string"
      ? item.group_name.trim()
      : "";
    if (groupId === null || !groupName || groups.has(groupId)) continue;
    groups.set(groupId, {
      groupId,
      groupName,
      parentId: positiveInteger(item.parent_id),
      sortOrder: finiteInteger(item.sort_order),
      directItemCount: nonNegativeCount(item.direct_item_count),
      subtreeItemCount: nonNegativeCount(item.subtree_item_count),
      children: [],
    });
  }

  const safeParentId = (node: WatchlistGroupNode): number | null => {
    const parentId = node.parentId;
    if (parentId === null || !groups.has(parentId)) return null;
    const visited = new Set<number>([node.groupId]);
    let cursor: number | null = parentId;
    while (cursor !== null) {
      if (visited.has(cursor)) return null;
      visited.add(cursor);
      cursor = groups.get(cursor)?.parentId ?? null;
    }
    return parentId;
  };

  const roots: WatchlistGroupNode[] = [];
  for (const node of groups.values()) {
    const parentId = safeParentId(node);
    node.parentId = parentId;
    if (parentId === null) roots.push(node);
    else groups.get(parentId)?.children.push(node);
  }

  const sortNodes = (nodes: WatchlistGroupNode[]) => {
    nodes.sort(compareWatchlistGroups);
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

export function findWatchlistGroupPath(
  tree: WatchlistGroupNode[],
  groupId: number,
): number[] {
  for (const node of tree) {
    if (node.groupId === groupId) return [node.groupId];
    const childPath = findWatchlistGroupPath(node.children, groupId);
    if (childPath.length > 0) return [node.groupId, ...childPath];
  }
  return [];
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function dashboardWatchlistGroupId(
  snapshot: DashboardSnapshot | null,
): number | null {
  if (!snapshot || !isRecord(snapshot.watchlist)) return null;
  const selection = snapshot.watchlist.selection;
  if (!isRecord(selection)) return null;
  const groupId = selection.group_id;
  return typeof groupId === "number" && Number.isFinite(groupId)
    ? groupId
    : null;
}

export function dashboardWatchlistIncludesChildren(
  snapshot: DashboardSnapshot | null,
): boolean | null {
  if (!snapshot || !isRecord(snapshot.watchlist)) return null;
  const selection = snapshot.watchlist.selection;
  if (!isRecord(selection)) return null;
  return typeof selection.include_children === "boolean"
    ? selection.include_children
    : null;
}

export function dashboardWatchlistItemBatch(
  snapshot: DashboardSnapshot | null,
  expectedGroupId: number,
): WatchlistItemBatch | null {
  if (!snapshot || !isRecord(snapshot.watchlist)) return null;
  if (dashboardWatchlistGroupId(snapshot) !== expectedGroupId) return null;
  if (dashboardWatchlistIncludesChildren(snapshot) !== false) return null;
  if (!Array.isArray(snapshot.watchlist.items)) return null;
  const selection = snapshot.watchlist.selection;
  if (!isRecord(selection)) return null;
  return {
    groupId: expectedGroupId,
    items: snapshot.watchlist.items.filter(isRecord),
    truncated: selection.truncated === true,
  };
}

export function buildDashboardRequest(
  scope: DashboardScope,
): Record<string, unknown> {
  return {
    ...(scope.watchlistGroupId === null
      ? {}
      : { watchlist_group_id: scope.watchlistGroupId }),
    include_watchlist_children: false,
    watchlist_limit: 40,
    group_limit: 10,
  };
}

export function shouldAdoptSnapshot(
  current: DashboardSnapshot | null,
  candidate: DashboardSnapshot,
  expectedScope: DashboardScope = { watchlistGroupId: null },
): boolean {
  const candidateGroupId = dashboardWatchlistGroupId(candidate);
  if (dashboardWatchlistIncludesChildren(candidate) !== false) return false;
  if (
    expectedScope.watchlistGroupId !== null &&
    candidateGroupId !== expectedScope.watchlistGroupId
  ) {
    return false;
  }
  if (!current) return true;
  if (
    expectedScope.watchlistGroupId !== null &&
    dashboardWatchlistGroupId(current) !== candidateGroupId
  ) {
    return true;
  }
  if (candidate.state_version !== current.state_version) {
    return candidate.state_version > current.state_version;
  }
  const candidateTime = timestamp(candidate.as_of);
  const currentTime = timestamp(current.as_of);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.snapshot_id === current.snapshot_id;
}

export function backoffDelay(
  failureCount: number,
  randomValue: number,
  baseMs = 30_000,
  maximumMs = 240_000,
): number {
  const exponent = Math.max(0, Math.min(failureCount, 3));
  const boundedRandom = Math.max(0, Math.min(randomValue, 1));
  const jitter = 0.85 + boundedRandom * 0.3;
  return Math.round(Math.min(baseMs * 2 ** exponent, maximumMs) * jitter);
}
