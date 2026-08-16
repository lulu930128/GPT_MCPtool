import assert from "node:assert/strict";
import test from "node:test";

import {
  backoffDelay,
  buildWatchlistTree,
  buildDashboardRequest,
  dashboardWatchlistItemBatch,
  type DashboardSnapshot,
  findWatchlistGroupPath,
  parseDashboard,
  shouldAdoptSnapshot,
} from "./state";

function snapshot(
  version: number,
  asOf: string,
  groupId = 1,
  includeChildren = false,
): DashboardSnapshot {
  return {
    kind: "omi.tw_market_dashboard",
    version: "omi.tw_market_dashboard.v1",
    snapshot_id: `snapshot-${version}-${asOf}`,
    state_version: version,
    trade_date: "2026-08-14",
    as_of: asOf,
    session: {},
    indices: [],
    breadth: {},
    hot_groups: [],
    watchlist: {
      selection: {
        group_id: groupId,
        include_children: includeChildren,
        truncated: false,
      },
      items: [],
    },
    freshness: {},
    warnings: [],
    limitations: [],
  };
}

test("rejects malformed dashboard host payloads", () => {
  assert.equal(parseDashboard({ kind: "wrong" }), null);
  assert.equal(parseDashboard(null), null);
});

test("prevents an older tool result from overwriting a newer snapshot", () => {
  const current = snapshot(200, "2026-08-14T08:35:00+08:00");
  assert.equal(
    shouldAdoptSnapshot(
      current,
      snapshot(199, "2026-08-14T08:36:00+08:00"),
    ),
    false,
  );
  assert.equal(
    shouldAdoptSnapshot(
      current,
      snapshot(201, "2026-08-14T08:34:00+08:00"),
    ),
    true,
  );
});

test("uses as-of as the tie breaker for equal state versions", () => {
  const current = snapshot(200, "2026-08-14T08:35:00+08:00");
  assert.equal(
    shouldAdoptSnapshot(
      current,
      snapshot(200, "2026-08-14T08:35:30+08:00"),
    ),
    true,
  );
});

test("adopts an explicitly requested watchlist scope at the same market time", () => {
  const current = snapshot(200, "2026-08-14T08:35:00+08:00", 36);
  const candidate = snapshot(200, "2026-08-14T08:35:00+08:00", 40);
  assert.equal(
    shouldAdoptSnapshot(current, candidate, { watchlistGroupId: 40 }),
    true,
  );
});

test("rejects a late snapshot from the previous watchlist scope", () => {
  const current = snapshot(200, "2026-08-14T08:35:00+08:00", 40);
  const latePreviousScope = snapshot(201, "2026-08-14T08:36:00+08:00", 36);
  assert.equal(
    shouldAdoptSnapshot(current, latePreviousScope, {
      watchlistGroupId: 40,
    }),
    false,
  );
});

test("rejects an aggregated descendant watchlist snapshot", () => {
  const current = snapshot(200, "2026-08-14T08:35:00+08:00", 36);
  const aggregated = snapshot(201, "2026-08-14T08:36:00+08:00", 36, true);
  assert.equal(
    shouldAdoptSnapshot(current, aggregated, { watchlistGroupId: 36 }),
    false,
  );
});

test("extracts stock leaves only from an exact direct-group snapshot", () => {
  const direct = snapshot(200, "2026-08-14T08:35:00+08:00", 45);
  direct.watchlist.items = [
    { stock_id: "2330", stock_name: "台積電" },
    { stock_id: "2303", stock_name: "聯電" },
    "malformed",
  ];
  assert.deepEqual(dashboardWatchlistItemBatch(direct, 45), {
    groupId: 45,
    items: [
      { stock_id: "2330", stock_name: "台積電" },
      { stock_id: "2303", stock_name: "聯電" },
    ],
    truncated: false,
  });
  assert.equal(dashboardWatchlistItemBatch(direct, 59), null);
  assert.equal(
    dashboardWatchlistItemBatch(
      snapshot(200, "2026-08-14T08:35:00+08:00", 45, true),
      45,
    ),
    null,
  );
});

test("builds one bounded dashboard request for initial load and polling", () => {
  assert.deepEqual(buildDashboardRequest({ watchlistGroupId: null }), {
    include_watchlist_children: false,
    watchlist_limit: 40,
    group_limit: 10,
  });
  assert.deepEqual(buildDashboardRequest({ watchlistGroupId: 40 }), {
    watchlist_group_id: 40,
    include_watchlist_children: false,
    watchlist_limit: 40,
    group_limit: 10,
  });
});

test("builds a stable recursive watchlist tree from backend group metadata", () => {
  const tree = buildWatchlistTree([
    { group_id: 2, group_name: "科技／電子", parent_id: null, sort_order: 200 },
    {
      group_id: 1,
      group_name: "ETF／市場指標",
      parent_id: null,
      sort_order: 100,
      direct_item_count: 3,
      subtree_item_count: 27,
    },
    { group_id: 3, group_name: "高股息", parent_id: 1, sort_order: 400 },
    { group_id: 4, group_name: "主動式台股 ETF", parent_id: 3, sort_order: 100 },
    { group_id: 5, group_name: "孤兒群組", parent_id: 999, sort_order: 300 },
    { group_id: 4, group_name: "重複群組", parent_id: null, sort_order: 1 },
    { group_id: "bad", group_name: "忽略", parent_id: null, sort_order: 1 },
  ]);

  assert.deepEqual(tree.map((node) => node.groupId), [1, 2, 5]);
  assert.equal(tree[0]?.directItemCount, 3);
  assert.equal(tree[0]?.subtreeItemCount, 27);
  assert.deepEqual(findWatchlistGroupPath(tree, 4), [1, 3, 4]);
  assert.equal(tree[0]?.children[0]?.children[0]?.groupName, "主動式台股 ETF");
});

test("fails open as roots for cyclic watchlist parents", () => {
  const tree = buildWatchlistTree([
    { group_id: 6, group_name: "循環 A", parent_id: 7, sort_order: 10 },
    { group_id: 7, group_name: "循環 B", parent_id: 6, sort_order: 20 },
  ]);

  assert.deepEqual(findWatchlistGroupPath(tree, 7), [6, 7]);
});

test("backoff is bounded and jittered", () => {
  assert.equal(backoffDelay(0, 0), 25_500);
  assert.equal(backoffDelay(0, 1), 34_500);
  assert.ok(backoffDelay(10, 1) <= 276_000);
});
