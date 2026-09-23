// ============================================================
// App.tsx —— 页面交互层
// 负责：时间轴、点位平面图、变更编辑、双人确认、变更记录与
//       版本档案的渲染和交互；业务判定走 rules.ts，状态与
//       持久化走 store.ts。
// ============================================================

import { useMemo, useState } from "react";
import "./styles.css";
import {
  BEAT_TOLERANCE_MS,
  MIN_GAP_MS,
  POINTS,
  ROLE_NAME,
  ROLES,
  SEGMENTS,
  TOTAL_MS,
  ChangeItem,
  ItemCheck,
  NodeLike,
  buildChangeItems,
  evaluateItems,
  formatDelta,
  formatMs,
  inspectItems,
  pointName,
  segmentOf,
} from "./rules";
import {
  ChangeOrder,
  activeOrder,
  cancelDraft,
  confirmRole,
  hasValidConfirm,
  resetAll,
  reviseActiveOrder,
  selectNodeForEdit,
  submitProposal,
  updateDraft,
  useConsoleState,
  withdrawActiveOrder,
} from "./store";

// ---------- 展示辅助 ----------
const POINT_COLORS: Record<string, string> = {
  "pt-a": "#f59e0b",
  "pt-b": "#3b82f6",
  "pt-c": "#22c55e",
  "pt-d": "#e879f9",
};

const STATUS_TEXT: Record<ChangeOrder["status"], string> = {
  pending: "待确认",
  approved: "已签批",
  returned: "已退回",
  withdrawn: "已撤回",
};

function pointColor(pointId: string): string {
  return POINT_COLORS[pointId] ?? "#94a3b8";
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("zh-CN")} ${d.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

/** 历史变更单的逐项检查以其基线版本快照为准；进行中的用当前脚本 */
function checksForOrder(order: ChangeOrder, nodes: NodeLike[], versions: { version: number; nodes: NodeLike[] }[]): ItemCheck[] {
  if (order.status === "pending") return inspectItems(nodes, order.items);
  const base = versions.find((v) => v.version === order.baseVersion);
  return inspectItems(base ? base.nodes : nodes, order.items);
}

// ---------- 主组件 ----------
export default function App() {
  const state = useConsoleState();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const order = activeOrder(state);
  const draft = state.draft;

  const draftItems = useMemo(
    () => (draft ? buildChangeItems(state.nodes, draft.anchorNodeId, draft.newFireMs) : []),
    [state.nodes, draft]
  );
  const draftViolations = useMemo(
    () => (draftItems.length ? evaluateItems(state.nodes, draftItems) : []),
    [state.nodes, draftItems]
  );

  const previewItems: ChangeItem[] = order ? order.items : draftItems;
  const selectedNode = state.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const shownVersion = viewVersion ?? state.scriptVersion;
  const shownSnapshot =
    state.versions.find((v) => v.version === shownVersion) ??
    state.versions[state.versions.length - 1];

  const handleNodeClick = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node && !node.executed && !order) selectNodeForEdit(nodeId);
  };

  return (
    <main className="console">
      <header className="topbar">
        <div>
          <p className="crumb">hxyfront-62008 · 烟花燃放编排 · 变更单台</p>
          <h1>燃放脚本变更单台</h1>
        </div>
        <div className="topbar-side">
          <span className="version-badge">当前签批 v{state.scriptVersion}</span>
          <span className="meta">
            {SEGMENTS.length} 段节目 · {state.nodes.length} 个节点 · {POINTS.length} 个点位
          </span>
          <button
            className="ghost"
            onClick={() => {
              if (window.confirm("恢复预置数据并清空全部变更记录与版本档案？")) resetAll();
            }}
          >
            重置数据
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="col-main">
          <TimelinePanel
            nodes={state.nodes}
            previewItems={previewItems}
            selectedNodeId={selectedNodeId}
            onNodeClick={handleNodeClick}
          />
          <MapPanel
            nodes={state.nodes}
            previewItems={previewItems}
            selectedNodeId={selectedNodeId}
            onNodeClick={handleNodeClick}
          />
        </section>

        <aside className="col-side">
          {order ? (
            <OrderPanel order={order} nodes={state.nodes} versions={state.versions} />
          ) : (
            <DraftPanel
              draft={draft}
              items={draftItems}
              violations={draftViolations}
              nodes={state.nodes}
              selectedNode={selectedNode}
            />
          )}
        </aside>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>变更记录</h2>
          <span className="meta">{state.orders.length} 张变更单</span>
        </div>
        {state.orders.length === 0 ? (
          <p className="empty">暂无变更单。在时间轴或点位图中点击未执行节点即可发起变更。</p>
        ) : (
          <div className="order-list">
            {state.orders.map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                nodes={state.nodes}
                versions={state.versions}
                expanded={expandedOrderId === o.id}
                onToggle={() => setExpandedOrderId(expandedOrderId === o.id ? null : o.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>签批版本档案</h2>
          <span className="meta">旧版本全部保留，当前 v{state.scriptVersion}</span>
        </div>
        <div className="version-tabs">
          {state.versions.map((v) => (
            <button
              key={v.version}
              className={`chip ${shownVersion === v.version ? "chip-on" : ""}`}
              onClick={() => setViewVersion(v.version)}
            >
              v{v.version}
              {v.version === state.scriptVersion ? " · 当前" : ""}
            </button>
          ))}
        </div>
        {shownSnapshot && (
          <>
            <p className="meta snapshot-meta">
              v{shownSnapshot.version} · 生成于 {fmtTime(shownSnapshot.createdAt)} · 来源{" "}
              {shownSnapshot.orderId ?? "初始签批"}
            </p>
            <table className="grid">
              <thead>
                <tr>
                  <th>节点</th>
                  <th>点位</th>
                  <th>点火时间</th>
                  <th>持续</th>
                  <th>音乐拍点</th>
                  <th>状态</th>
                  <th>签批版本</th>
                </tr>
              </thead>
              <tbody>
                {shownSnapshot.nodes.map((n) => (
                  <tr key={n.id}>
                    <td>{n.label}</td>
                    <td>
                      <i className="dot" style={{ background: pointColor(n.pointId) }} />
                      {pointName(n.pointId)}
                    </td>
                    <td className="mono">{formatMs(n.fireMs)}</td>
                    <td className="mono">{(n.durationMs / 1000).toFixed(1)}s</td>
                    <td className="mono">{formatMs(n.beatMs)}</td>
                    <td>{n.executed ? "已执行" : "未执行"}</td>
                    <td>v{n.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}

// ---------- 时间轴 ----------
function TimelinePanel(props: {
  nodes: NodeLike[];
  previewItems: ChangeItem[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
}) {
  const { nodes, previewItems, selectedNodeId, onNodeClick } = props;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>时间轴</h2>
        <span className="meta">
          全程 {formatMs(TOTAL_MS)} · 拍点容差 ±{BEAT_TOLERANCE_MS}ms · 同点位间隔 ≥{" "}
          {(MIN_GAP_MS / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="timeline">
        {SEGMENTS.map((seg) => {
          const width = ((seg.endMs - seg.startMs) / TOTAL_MS) * 100;
          const segNodes = nodes.filter(
            (n) => n.fireMs >= seg.startMs && n.fireMs < seg.endMs
          );
          const ghosts = previewItems.filter((it) => {
            const s = segmentOf(it.newFireMs);
            return s?.id === seg.id;
          });
          return (
            <div key={seg.id} className="lane" style={{ width: `${width}%` }}>
              <div className="lane-head">
                <b>{seg.name}</b>
                <span className="mono">
                  {formatMs(seg.startMs)} – {formatMs(seg.endMs)}
                </span>
              </div>
              <div className="lane-body">
                {segNodes.map((n) => {
                  const left = ((n.fireMs - seg.startMs) / (seg.endMs - seg.startMs)) * 100;
                  return (
                    <button
                      key={n.id}
                      className={`marker ${n.executed ? "marker-done" : ""} ${
                        selectedNodeId === n.id ? "marker-on" : ""
                      }`}
                      style={{ left: `${left}%`, background: pointColor(n.pointId) }}
                      title={`${n.label} · ${pointName(n.pointId)} · ${formatMs(n.fireMs)} · v${"version" in n ? (n as { version: number }).version : 1}`}
                      onClick={() => onNodeClick(n.id)}
                    >
                      {n.label.slice(0, 2)}
                    </button>
                  );
                })}
                {ghosts.map((it) => {
                  const left =
                    ((it.newFireMs - seg.startMs) / (seg.endMs - seg.startMs)) * 100;
                  return (
                    <span
                      key={`ghost-${it.nodeId}`}
                      className="marker marker-ghost"
                      style={{ left: `${left}%`, borderColor: pointColor(it.pointId) }}
                      title={`${it.label} 变更后 ${formatMs(it.newFireMs)}`}
                    >
                      {it.label.slice(0, 2)}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="legend">
        {POINTS.map((p) => (
          <span key={p.id}>
            <i className="dot" style={{ background: pointColor(p.id) }} />
            {p.name}
          </span>
        ))}
        <span>
          <i className="dot dot-ghost" /> 变更后位置
        </span>
        <span>
          <i className="dot dot-done" /> 已执行
        </span>
      </div>
    </section>
  );
}

// ---------- 点位平面图 ----------
function MapPanel(props: {
  nodes: NodeLike[];
  previewItems: ChangeItem[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
}) {
  const { nodes, previewItems, selectedNodeId, onNodeClick } = props;
  const affectedPoints = new Set(previewItems.map((it) => it.pointId));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>点位平面图</h2>
        <span className="meta">点击点位节点可发起变更（已执行节点除外）</span>
      </div>
      <div className="map">
        {POINTS.map((p) => {
          const pts = nodes.filter((n) => n.pointId === p.id);
          return (
            <div
              key={p.id}
              className={`map-point ${affectedPoints.has(p.id) ? "map-point-hot" : ""}`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
            >
              <span className="map-pin" style={{ background: pointColor(p.id) }}>
                {p.name}
              </span>
              <div className="map-nodes">
                {pts.map((n) => (
                  <button
                    key={n.id}
                    className={`map-node ${n.executed ? "map-node-done" : ""} ${
                      selectedNodeId === n.id ? "map-node-on" : ""
                    }`}
                    onClick={() => onNodeClick(n.id)}
                  >
                    {n.label.slice(0, 2)} {formatMs(n.fireMs)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- 变更项表格（编辑预览 / 变更单详情共用） ----------
function ItemsTable({ items, checks }: { items: ChangeItem[]; checks: ItemCheck[] }) {
  const checkByNode = new Map(checks.map((c) => [c.nodeId, c]));
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>节点</th>
          <th>来源</th>
          <th>原时间</th>
          <th>新时间</th>
          <th>拍点偏差</th>
          <th>前发间隔</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const c = checkByNode.get(it.nodeId);
          const bad = c && (c.crossSegment || c.beatViolation || c.gapViolation);
          return (
            <tr key={it.nodeId} className={bad ? "row-bad" : ""}>
              <td>{it.label}</td>
              <td>{it.kind === "anchor" ? "锚点" : "传播"}</td>
              <td className="mono">{formatMs(it.oldFireMs)}</td>
              <td className="mono">
                {formatMs(it.newFireMs)}
                <em className="delta">{formatDelta(it.deltaMs)}</em>
              </td>
              <td className={`mono ${c?.beatViolation ? "cell-bad" : ""}`}>
                {c ? `${Math.round(c.beatDevMs)}ms` : "—"}
              </td>
              <td className={`mono ${c?.gapViolation ? "cell-bad" : ""}`}>
                {c?.gapMs != null ? `${Math.round(c.gapMs)}ms` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ViolationList({ violations }: { violations: { nodeId: string; label: string; reasons: string[] }[] }) {
  if (violations.length === 0) return null;
  return (
    <div className="violations">
      <b>触发退回规则（整单退回，原脚本不动）：</b>
      <ul>
        {violations.map((v) => (
          <li key={v.nodeId}>
            {v.label}：{v.reasons.join("；")}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 变更编辑（草稿） ----------
function DraftPanel(props: {
  draft: { anchorNodeId: string; newFireMs: number } | null;
  items: ChangeItem[];
  violations: { nodeId: string; label: string; reasons: string[] }[];
  nodes: NodeLike[];
  selectedNode: NodeLike | null;
}) {
  const { draft, items, violations, nodes, selectedNode } = props;
  const anchor = draft ? nodes.find((n) => n.id === draft.anchorNodeId) : null;

  if (!draft || !anchor) {
    return (
      <section className="panel side-panel">
        <div className="panel-head">
          <h2>变更编辑</h2>
        </div>
        {selectedNode ? (
          <div className="node-brief">
            <p>
              <b>{selectedNode.label}</b> · {pointName(selectedNode.pointId)}
            </p>
            <p className="mono">点火 {formatMs(selectedNode.fireMs)} · 拍点 {formatMs(selectedNode.beatMs)}</p>
            {selectedNode.executed ? (
              <p className="warn">该节点已执行，不可变更。</p>
            ) : (
              <p className="meta">存在待确认变更单时不可新建；否则点击节点即可编辑。</p>
            )}
          </div>
        ) : (
          <p className="empty">在时间轴或点位图中点击一个未执行节点，开始填写变更单。</p>
        )}
      </section>
    );
  }

  const checks = inspectItems(nodes, items);
  const delta = draft.newFireMs - anchor.fireMs;
  return (
    <section className="panel side-panel">
      <div className="panel-head">
        <h2>变更编辑</h2>
        <span className="tag tag-draft">草稿</span>
      </div>
      <p className="meta">
        锚点 <b>{anchor.label}</b> · {pointName(anchor.pointId)} · 当前{" "}
        <span className="mono">{formatMs(anchor.fireMs)}</span>
      </p>
      <label className="field">
        <span>新点火时间（毫秒）</span>
        <input
          type="number"
          min={0}
          max={TOTAL_MS}
          step={50}
          value={draft.newFireMs}
          onChange={(e) => updateDraft(Number(e.target.value))}
        />
      </label>
      <input
        className="slider"
        type="range"
        min={0}
        max={TOTAL_MS}
        step={50}
        value={draft.newFireMs}
        onChange={(e) => updateDraft(Number(e.target.value))}
      />
      <p className="meta">
        新时间 <span className="mono">{formatMs(draft.newFireMs)}</span>（
        {formatDelta(delta)}）· 传播 {items.length - 1} 个后续节点
      </p>
      <ItemsTable items={items} checks={checks} />
      <ViolationList violations={violations} />
      <div className="btn-row">
        <button
          className="primary"
          disabled={delta === 0}
          title={delta === 0 ? "时间未变化" : violations.length ? "提交后将因违规被整单退回" : "提交后进入双人确认"}
          onClick={submitProposal}
        >
          {violations.length > 0 ? "提交（将被退回）" : "提交变更单"}
        </button>
        <button className="ghost" onClick={cancelDraft}>
          取消
        </button>
      </div>
    </section>
  );
}

// ---------- 待确认变更单（双人确认） ----------
function OrderPanel(props: {
  order: ChangeOrder;
  nodes: NodeLike[];
  versions: { version: number; nodes: NodeLike[] }[];
}) {
  const { order, nodes, versions } = props;
  const [reviseMs, setReviseMs] = useState(order.newFireMs);
  const checks = checksForOrder(order, nodes, versions);

  return (
    <section className="panel side-panel">
      <div className="panel-head">
        <h2>{order.id}</h2>
        <span className="tag tag-pending">待确认 · 第{order.proposalVersion}版</span>
      </div>
      <p className="meta">
        锚点 <b>{order.anchorLabel}</b> · {pointName(order.pointId)} ·{" "}
        <span className="mono">
          {formatMs(order.oldFireMs)} → {formatMs(order.newFireMs)}（{formatDelta(order.deltaMs)}）
        </span>
      </p>
      <ItemsTable items={order.items} checks={checks} />

      <div className="confirm-box">
        {ROLES.map((r) => {
          const ok = hasValidConfirm(order, r.id);
          const conf = order.confirms.find((c) => c.role === r.id);
          return (
            <div key={r.id} className={`confirm-cell ${ok ? "confirm-ok" : ""}`}>
              <b>{ROLE_NAME[r.id]}</b>
              <span>{ok ? `已确认 · ${fmtTime(conf?.at ?? null)}` : "未确认"}</span>
              <button className="primary" disabled={ok} onClick={() => confirmRole(r.id)}>
                {ok ? "已确认" : "确认"}
              </button>
            </div>
          );
        })}
      </div>
      {order.voidedConfirms.length > 0 && (
        <p className="warn">
          {order.voidedConfirms.length} 次确认因变更单版本更新已作废，需重新确认。
        </p>
      )}
      <p className="meta">两人对同一版本均确认后，整体生成新签批版本。</p>

      <div className="revise-box">
        <span className="meta">修改锚点时间（将使现有确认作废；违规则整单退回）</span>
        <div className="btn-row">
          <input
            type="number"
            min={0}
            max={TOTAL_MS}
            step={50}
            value={reviseMs}
            onChange={(e) => setReviseMs(Number(e.target.value))}
          />
          <button className="ghost" onClick={() => reviseActiveOrder(reviseMs)}>
            修改送审
          </button>
          <button className="danger" onClick={withdrawActiveOrder}>
            撤回
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------- 变更记录行 ----------
function OrderRow(props: {
  order: ChangeOrder;
  nodes: NodeLike[];
  versions: { version: number; nodes: NodeLike[] }[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { order, nodes, versions, expanded, onToggle } = props;
  const checks = expanded ? checksForOrder(order, nodes, versions) : [];
  return (
    <article className={`order-row status-${order.status}`}>
      <button className="order-summary" onClick={onToggle}>
        <span className={`tag tag-${order.status}`}>{STATUS_TEXT[order.status]}</span>
        <b>{order.id}</b>
        <span>
          {order.anchorLabel} · {pointName(order.pointId)}
        </span>
        <span className="mono">
          {formatMs(order.oldFireMs)} → {formatMs(order.newFireMs)}
        </span>
        <span className="meta">
          基线 v{order.baseVersion}
          {order.approvedVersion ? ` → v${order.approvedVersion}` : ""} · 第
          {order.proposalVersion}版 · {fmtTime(order.createdAt)}
        </span>
      </button>
      {expanded && (
        <div className="order-detail">
          <ItemsTable items={order.items} checks={checks} />
          {order.violations.length > 0 && <ViolationList violations={order.violations} />}
          <div className="confirm-log">
            {order.confirms.map((c) => (
              <span key={`${c.role}-${c.at}`} className="tag tag-ok">
                {ROLE_NAME[c.role]} 已确认（第{c.proposalVersion}版）{fmtTime(c.at)}
              </span>
            ))}
            {order.voidedConfirms.map((c, i) => (
              <span key={`void-${i}`} className="tag tag-void">
                {ROLE_NAME[c.role]} 确认作废（第{c.proposalVersion}版）{fmtTime(c.voidedAt)}
              </span>
            ))}
            {order.confirms.length === 0 && order.voidedConfirms.length === 0 && (
              <span className="meta">无确认记录</span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
