import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildWatchlistTree, findWatchlistGroupPath, isRecord, type UnknownRecord, type WatchlistGroupNode } from "./state";
import type { PaneState } from "./workspace-state";
import { StatusBadge } from "./workspace-evidence";

export function hasContentBelow({ scrollHeight, clientHeight, scrollTop }: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">): boolean {
  return clientHeight > 0 && scrollHeight - clientHeight - scrollTop > 1;
}

export function observeGroupOverflow(viewport: HTMLElement, content: HTMLElement, publish: (value: boolean) => void): () => void {
  const update = () => publish(hasContentBelow(viewport));
  const observer = new ResizeObserver(update);
  observer.observe(viewport);
  observer.observe(content);
  viewport.addEventListener("scroll", update, { passive: true });
  // toggle does not bubble: capture nested expansion and collapse events.
  viewport.addEventListener("toggle", update, true);
  update();
  return () => {
    observer.disconnect();
    viewport.removeEventListener("scroll", update);
    viewport.removeEventListener("toggle", update, true);
  };
}

type WatchlistPane = PaneState & { key: string | null; retry: () => void };
type StockSelection = { selectedStock?: string; selectStock: (symbol: string) => void };
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const label = (value: unknown) => typeof value === "string" && value ? value : "—";
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "—";

export function SelectedGroupItems({ pane, selected, selectedStock, selectStock }: StockSelection & { pane: WatchlistPane; selected?: number }) {
  // Retained metadata can still navigate the tree, but retained rows must never
  // cross a request/selection boundary (including the render before effects run).
  const current = pane.data !== null && pane.dataKey === pane.key && record(pane.data.selection).group_id === selected;
  const data = current ? pane.data : null;
  const items = Array.isArray(data?.items) ? data.items.filter(isRecord) : [];
  return <div className="workspace-group-items" aria-label="當前群組股票清單" aria-busy={pane.loading}>
    {(pane.loading || (!current && !pane.error)) && <p role="status" className="workspace-loading">讀取此群組中…{current ? " 保留此群組上次結果" : ""}</p>}
    {pane.error && <p role="alert" className="workspace-error">讀取失敗{current ? " · 保留此群組上次結果" : ""}</p>}
    {record(data?.selection).truncated === true && <p role="status">清單已截斷；僅顯示回傳範圍</p>}
    {data && items.length === 0 && <p role="status">本次回傳沒有直接標的；可展開子群組或選擇其他群組。</p>}
    {items.map((item) => <button type="button" className="workspace-stock" key={label(item.stock_id)} aria-pressed={selectedStock === item.stock_id} onClick={() => selectStock(label(item.stock_id))}>
      <strong>{label(item.stock_id)} {label(item.stock_name)}</strong><span>{numeric(item.price)} / {numeric(item.change_pct)}{numeric(item.change_pct) !== "—" ? "%" : ""}</span><StatusBadge data={item} />
    </button>)}
    {!pane.error && <StatusBadge data={data} />}
  </div>;
}

type TreeProps = { nodes: WatchlistGroupNode[]; selected?: number; select: (id: number) => void; path: number[]; inline: ReactNode };
export function GroupBranch({ node, ...props }: Omit<TreeProps, "nodes"> & { node: WatchlistGroupNode }) {
  const onPath = props.path.includes(node.groupId);
  const [open, setOpen] = useState(onPath);
  useEffect(() => { if (onPath) setOpen(true); }, [onPath, props.selected]);
  const row = <button type="button" data-group-id={node.groupId} aria-pressed={props.selected === node.groupId} onClick={() => props.select(node.groupId)}>{node.groupName}</button>;
  const inline = props.selected === node.groupId ? props.inline : null;
  return <li data-group-node={node.groupId}>
    <div className="workspace-group-row">
      {node.children.length > 0 ? <button type="button" className="workspace-group-toggle" aria-label={`${open ? "收合" : "展開"} ${node.groupName} 子群組`} aria-expanded={open} aria-controls={`workspace-group-children-${node.groupId}`} onClick={() => setOpen((value) => !value)}><span aria-hidden="true">{open ? "▾" : "▸"}</span></button> : <span className="workspace-group-spacer" aria-hidden="true" />}
      {row}
    </div>{inline}
    {node.children.length > 0 && <div id={`workspace-group-children-${node.groupId}`} hidden={!open}>
      <GroupTree {...props} nodes={node.children} />
    </div>}
  </li>;
}

function GroupTree({ nodes, ...props }: TreeProps) {
  return <ul className="workspace-group-tree">{nodes.map((node) => <GroupBranch key={node.groupId} node={node} {...props} />)}</ul>;
}

// Move only the inner viewport, and only enough to reveal the selected heading.
// Never scroll the page, reset to the top, or re-anchor on polling/stock clicks.
export function revealGroup(viewport: HTMLElement, row: HTMLElement, headingHeight: number): void {
  const bounds = viewport.getBoundingClientRect();
  const target = row.getBoundingClientRect();
  const top = bounds.top + headingHeight + 4;
  const bottom = bounds.bottom - 16;
  if (target.top < top) viewport.scrollTop += target.top - top;
  else if (target.bottom > bottom) viewport.scrollTop += target.bottom - bottom;
}

export function GroupNavigation({ pane, selected, select, ...stock }: StockSelection & { pane: WatchlistPane; selected?: number; select: (id: number) => void }) {
  const nodes = useMemo(() => buildWatchlistTree(pane.data?.groups), [pane.data?.groups]);
  const path = selected === undefined ? [] : findWatchlistGroupPath(nodes, selected);
  const pathKey = path.join("/");
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (viewport.current && content.current) return observeGroupOverflow(viewport.current, content.current, setMore);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const row = viewport.current?.querySelector<HTMLElement>(`[data-group-id="${selected}"]`);
      if (viewport.current && row) revealGroup(viewport.current, row, heading.current?.offsetHeight ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, pathKey]);
  const inline = <SelectedGroupItems pane={pane} selected={selected} {...stock} />;
  return <section className="workspace-pane workspace-group-navigation" aria-label="自選族群與個股">
    <div className="workspace-group-scroll-shell" data-more-below={more}>
      <div ref={viewport} className="workspace-group-scroll" role="region" aria-label="自選群組導航" tabIndex={0}>
        <div ref={heading} className="workspace-pane-heading workspace-group-heading"><h2>自選族群與個股</h2><button type="button" onClick={pane.retry} disabled={pane.loading}>{pane.error ? "重試" : "重新讀取"}</button></div>
        <div ref={content}>
          <GroupTree nodes={nodes} selected={selected} select={select} path={path} inline={inline} />
          {path.length === 0 && <>{selected !== undefined && <p role="status">群組 {selected} 未出現在回傳階層中。</p>}{/* Never invent a node for unmatched stock rows. */}
            {pane.loading || !pane.data ? <p role="status">讀取群組階層中…</p> : <p role="status">請選擇群組；目前沒有可對應的群組節點。</p>}
            {pane.error ? <p role="alert" className="workspace-error">讀取失敗</p> : <StatusBadge data={pane.data} />}
          </>}
        </div>
      </div>
    </div>
  </section>;
}
