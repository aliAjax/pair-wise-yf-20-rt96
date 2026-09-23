// 页面交互层：时间轴编排、点位平面图、变更单工作台与变更记录。
// 业务判定来自 rules.ts，持久化来自 store.ts，本文件只负责渲染与事件。

import { useMemo, useState } from "react";
import {
  BEAT_TOLERANCE_MS,
  MIN_INTERVAL_MS,
  type ChangeOrder,
  type FiringNode,
  type ShowState,
  canApprove,
  effectiveConfirmation,
  fingerprint,
  formatMs,
} from "./rules";
import { useShowStore } from "./store";
import "./styles.css";

const SHOW_END_MS = 120_000;
const POSITION_COLORS: Record<string, string> = {
  A: "#1d4ed8",
  B: "#dc2626",
  C: "#0d9488",
  D: "#f59e0b",
};

export default function App() {
  const store = useShowStore();
  const { state } = store;
  const draft = state.changeOrders.find((c) => c.id === state.activeDraftId) ?? null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = state.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const sortedOrders = useMemo(
    () => [...state.changeOrders].sort((a, b) => b.createdAt - a.createdAt),
    [state.changeOrders],
  );

  return (
    <main className="app">
      <header className="hero">
        <div className="hero-top">
          <p>hxyfront-62008 · 变更单台</p>
          <button className="ghost" onClick={store.resetAll}>
            重置为预置脚本
          </button>
        </div>
        <h1>烟花编排变更单台</h1>
        <span>
          三段节目 · 六个节点 · 四个点位。改动已签批节点先生成变更单，沿同一点位后续未执行节点逐项传播；
          越段、拍点偏差 {BEAT_TOLERANCE_MS}ms、前发间隔 {MIN_INTERVAL_MS / 1000}s 任一触发即整张退回。
          安全与音乐负责人对同一版本双签后才生成新签批版本，旧版本保留。
        </span>
        <div className="version-badge">
          当前签批版本 <b>{state.currentVersionId}</b>
          <small>（共 {state.versions.length} 个历史版本，留档可查）</small>
        </div>
      </header>

      <section className="metrics">
        <article>
          <small>节目段落</small>
          <strong>{state.segments.length}</strong>
        </article>
        <article>
          <small>点火节点</small>
          <strong>{state.nodes.length}</strong>
        </article>
        <article>
          <small>已执行</small>
          <strong>{state.nodes.filter((n) => n.executed).length}</strong>
        </article>
        <article>
          <small>变更记录</small>
          <strong>{state.changeOrders.length}</strong>
        </article>
      </section>

      <section className="panel timeline-panel">
        <div className="heading">
          <div>
            <p>时间轴编排</p>
            <h2>整场时间轴（点击节点发起变更）</h2>
          </div>
          <div className="legend">
            {state.positions.map((p) => (
              <span key={p.id} className="legend-item">
                <i style={{ background: POSITION_COLORS[p.id] }} />
                {p.name}
              </span>
            ))}
          </div>
        </div>
        <Timeline state={state} draft={draft} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
      </section>

      <section className="workspace">
        <div className="left-col">
          <section className="panel">
            <div className="heading">
              <div>
                <p>点位平面图</p>
                <h2>四个燃放点位</h2>
              </div>
            </div>
            <PositionMap state={state} draft={draft} onSelect={setSelectedNodeId} />
          </section>

          <section className="panel">
            <div className="heading">
              <div>
                <p>变更记录</p>
                <h2>退回 / 签批留档</h2>
              </div>
            </div>
            <ChangeRecords orders={sortedOrders} state={state} />
          </section>
        </div>

        <section className="panel form-panel">
          {draft ? (
            <DraftPanel order={draft} state={state} store={store} />
          ) : selectedNode ? (
            <NodePanel node={selectedNode} state={state} store={store} onClose={() => setSelectedNodeId(null)} />
          ) : (
            <VersionHistory state={state} />
          )}
        </section>
      </section>
    </main>
  );
}

/* ---------------- 时间轴 ---------------- */

function Timeline({
  state,
  draft,
  selectedId,
  onSelect,
}: {
  state: ShowState;
  draft: ChangeOrder | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const draftTimes = new Map(draft?.items.map((i) => [i.nodeId, i]) ?? []);
  return (
    <div className="timeline">
      <div className="segment-row">
        {state.segments.map((s) => (
          <div
            key={s.id}
            className="segment-tag"
            style={{ left: `${(s.startMs / SHOW_END_MS) * 100}%`, width: `${((s.endMs - s.startMs) / SHOW_END_MS) * 100}%` }}
          >
            {s.name}
            <small>
              {formatMs(s.startMs)} – {formatMs(s.endMs)}
            </small>
          </div>
        ))}
      </div>

      <div className="ruler">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} style={{ left: `${(i * 20000 / SHOW_END_MS) * 100}%` }}>
            {formatMs(i * 20000)}
          </span>
        ))}
      </div>

      <div className="lane">
        {state.nodes.map((n) => {
          const item = draftTimes.get(n.id);
          const ignite = item ? item.newIgniteMs : n.igniteMs;
          const duration = item ? item.newDurationMs : n.durationMs;
          return (
            <button
              key={n.id}
              className={`node-block ${n.executed ? "executed" : ""} ${selectedId === n.id ? "selected" : ""} ${item ? (item.propagated ? "propagated" : "changed") : ""}`}
              style={{
                left: `${(ignite / SHOW_END_MS) * 100}%`,
                width: `${Math.max((duration / SHOW_END_MS) * 100, 1.6)}%`,
                background: POSITION_COLORS[n.positionId],
              }}
              title={`${n.id} ${n.name} · ${formatMs(igniteMsOf(n, item))}`}
              onClick={() => onSelect(n.id)}
            >
              <b>{n.id}</b>
              {item && <em>{item.propagated ? "传播" : "改"}</em>}
            </button>
          );
        })}
      </div>
      <p className="hint">
        深色为节点点火与持续时长；带「改」为变更源头，带「传播」为同点位后续未执行节点整体平移；已执行节点不参与变更。
      </p>
    </div>
  );
}

function igniteMsOf(n: FiringNode, item?: { newIgniteMs: number }) {
  return item ? item.newIgniteMs : n.igniteMs;
}

/* ---------------- 点位平面图 ---------------- */

function PositionMap({ state, draft, onSelect }: { state: ShowState; draft: ChangeOrder | null; onSelect: (id: string) => void }) {
  const draftNodes = new Map(draft?.items.map((i) => [i.nodeId, i]) ?? []);
  return (
    <div className="map">
      <div className="map-stage">舞台 / 水域</div>
      {state.positions.map((p) => {
        const nodes = state.nodes.filter((n) => n.positionId === p.id).sort((a, b) => a.igniteMs - b.igniteMs);
        return (
          <div key={p.id} className="map-point" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
            <div className="map-dot" style={{ borderColor: POSITION_COLORS[p.id] }}>
              {p.id}
            </div>
            <div className="map-label">
              <b>{p.name}</b>
              <span>
                {nodes.map((n) => {
                  const item = draftNodes.get(n.id);
                  return (
                    <button
                      key={n.id}
                      className={`map-node ${n.executed ? "executed" : ""} ${item ? (item.propagated ? "propagated" : "changed") : ""}`}
                      onClick={() => onSelect(n.id)}
                      title={`${n.versionId} · ${formatMs(item ? item.newIgniteMs : n.igniteMs)}`}
                    >
                      {n.id}
                    </button>
                  );
                })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 节点详情 / 发起变更 ---------------- */

type Store = ReturnType<typeof useShowStore>;

function NodePanel({ node, state, store, onClose }: { node: FiringNode; state: ShowState; store: Store; onClose: () => void }) {
  const segment = state.segments.find((s) => s.id === node.segmentId);
  const position = state.positions.find((p) => p.id === node.positionId);
  const [igniteMs, setIgniteMs] = useState(node.igniteMs);
  const [durationMs, setDurationMs] = useState(node.durationMs);
  const [beatMs, setBeatMs] = useState(node.beatMs);
  const [reason, setReason] = useState("");

  const changed = igniteMs !== node.igniteMs || durationMs !== node.durationMs || beatMs !== node.beatMs;

  return (
    <div>
      <div className="heading">
        <div>
          <p>节点详情 · 签批 {node.versionId}</p>
          <h2>
            {node.id} {node.name}
          </h2>
        </div>
        <button className="ghost" onClick={onClose}>
          收起
        </button>
      </div>

      <dl className="detail-list">
        <div>
          <dt>点位</dt>
          <dd>{position?.name}</dd>
        </div>
        <div>
          <dt>段落</dt>
          <dd>{segment?.name}</dd>
        </div>
        <div>
          <dt>点火毫秒</dt>
          <dd>{formatMs(node.igniteMs)}（{node.igniteMs}ms）</dd>
        </div>
        <div>
          <dt>持续毫秒</dt>
          <dd>{node.durationMs}ms</dd>
        </div>
        <div>
          <dt>音乐拍点</dt>
          <dd>
            {formatMs(node.beatMs)} · 偏差 {Math.abs(node.igniteMs - node.beatMs)}ms
          </dd>
        </div>
        <div>
          <dt>执行状态</dt>
          <dd>{node.executed ? "已执行（锁定）" : "未执行"}</dd>
        </div>
      </dl>

      {!node.executed && (
        <>
          <h3 className="form-title">改动已签批节点 → 先生成变更单</h3>
          <div className="field-grid">
            <NumberField label="新点火毫秒" value={igniteMs} onChange={setIgniteMs} />
            <NumberField label="新持续毫秒" value={durationMs} onChange={setDurationMs} />
            <NumberField label="新音乐拍点毫秒" value={beatMs} onChange={setBeatMs} />
            <label className="field">
              <span>变更原因</span>
              <input value={reason} placeholder="如：配合间奏延长" onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
          <div className="rule-preview">
            <span>新点火 {formatMs(igniteMs)}</span>
            <span>拍点偏差 {Math.abs(igniteMs - beatMs)}ms</span>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!changed}
              onClick={() => {
                store.openChange(node.id, { igniteMs, durationMs, beatMs }, reason);
              }}
            >
              生成变更单
            </button>
            <button className="ghost" onClick={() => store.toggleExecuted(node.id)}>
              标记为已执行
            </button>
          </div>
        </>
      )}
      {node.executed && <p className="hint">已执行节点已锁定，不再接受改动或传播。可取消执行状态后再变更。</p>}
      {node.executed && (
        <div className="actions">
          <button className="ghost" onClick={() => store.toggleExecuted(node.id)}>
            取消已执行
          </button>
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={10}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.round(v));
        }}
      />
    </label>
  );
}

/* ---------------- 变更单工作台 ---------------- */

function DraftPanel({ order, state, store }: { order: ChangeOrder; state: ShowState; store: Store }) {
  const fp = fingerprint(order);
  const safetyOk = effectiveConfirmation(order, "safety");
  const musicOk = effectiveConfirmation(order, "music");
  const approvable = canApprove(order);

  return (
    <div>
      <div className="heading">
        <div>
          <p>变更单 · {order.id}</p>
          <h2>{order.reason}</h2>
        </div>
        <span className={`status-tag ${order.violations.length > 0 ? "bad" : "ok"}`}>
          {order.violations.length > 0 ? `${order.violations.length} 项硬性违规` : "规则校验通过"}
        </span>
      </div>

      <div className="items">
        {order.items.map((item) => {
          const node = state.nodes.find((n) => n.id === item.nodeId)!;
          const itemViolations = order.violations.filter((v) => v.nodeId === item.nodeId);
          const editableIgnite = !node.executed;
          return (
            <article key={item.nodeId} className={`item-card ${itemViolations.length ? "violation" : ""}`}>
              <header>
                <b>
                  {item.nodeId} {node.name}
                </b>
                <span className="chip" style={{ borderColor: POSITION_COLORS[node.positionId], color: POSITION_COLORS[node.positionId] }}>
                  {node.positionId} 点位
                </span>
                {item.propagated && <span className="chip warn">逐项传播</span>}
              </header>
              <div className="item-grid">
                <label className="field">
                  <span>点火（{formatMs(item.oldIgniteMs)} →）</span>
                  <input
                    type="number"
                    disabled={!editableIgnite}
                    value={item.newIgniteMs}
                    step={10}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) store.editItem(item.nodeId, { newIgniteMs: Math.round(v) });
                    }}
                  />
                </label>
                <label className="field">
                  <span>音乐拍点</span>
                  <input
                    type="number"
                    disabled={!editableIgnite}
                    value={item.newBeatMs}
                    step={10}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) store.editItem(item.nodeId, { newBeatMs: Math.round(v) });
                    }}
                  />
                </label>
                <label className="field">
                  <span>持续毫秒</span>
                  <input
                    type="number"
                    disabled={item.propagated}
                    value={item.newDurationMs}
                    step={100}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) store.editItem(item.nodeId, { newDurationMs: Math.round(v) });
                    }}
                  />
                </label>
              </div>
              {itemViolations.length > 0 && (
                <ul className="violation-list">
                  {itemViolations.map((v, i) => (
                    <li key={i}>{v.message}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>

      {order.violations.length > 0 && (
        <div className="reject-banner">
          越段 / 拍点偏差超 {BEAT_TOLERANCE_MS}ms / 前发间隔短于 {(MIN_INTERVAL_MS / 1000).toFixed(1)}s —— 整张变更单必须退回，原脚本不动。
        </div>
      )}

      <p className="hint">
        源头节点调整点火毫秒时，同点位传播项按增量自动重平移；也可单独微调任一未执行项。每次修改都会刷新版本，双方须重新确认。
      </p>

      <div className="confirm-box">
        <p>双负责人会签（任一人看到的版本更新后，其确认自动作废）</p>
        <div className="confirm-row">
          <ConfirmButton
            role="安全负责人"
            ok={safetyOk}
            disabled={order.violations.length > 0}
            fp={fp}
            heldFp={order.safety?.fingerprint}
            onClick={() => store.confirm("safety")}
          />
          <ConfirmButton
            role="音乐负责人"
            ok={musicOk}
            disabled={order.violations.length > 0}
            fp={fp}
            heldFp={order.music?.fingerprint}
            onClick={() => store.confirm("music")}
          />
        </div>
      </div>

      <div className="actions">
        <button className="primary" disabled={!approvable} onClick={store.approve}>
          双签一致 · 整体生成新签批
        </button>
        <button className="danger" onClick={store.reject}>
          整张退回（原脚本不动）
        </button>
        <button className="ghost" onClick={store.cancelDraft}>
          废弃草稿
        </button>
      </div>
    </div>
  );
}

function ConfirmButton({
  role,
  ok,
  disabled,
  fp,
  heldFp,
  onClick,
}: {
  role: string;
  ok: boolean;
  disabled: boolean;
  fp: string;
  heldFp?: string;
  onClick: () => void;
}) {
  const stale = !!heldFp && heldFp !== fp;
  return (
    <button className={`confirm-btn ${ok ? "ok" : ""} ${stale ? "stale" : ""}`} disabled={disabled} onClick={onClick}>
      <b>{role}</b>
      <small>
        {ok ? `已确认同版本 ${fp.slice(-6)}` : stale ? "版本已更新，确认作废" : "待确认"}
      </small>
    </button>
  );
}

/* ---------------- 变更记录 ---------------- */

function ChangeRecords({ orders, state }: { orders: ChangeOrder[]; state: ShowState }) {
  if (orders.length === 0) return <p className="hint">暂无变更记录。</p>;
  return (
    <div className="records">
      {orders.map((o) => {
        const origin = state.nodes.find((n) => n.id === o.originNodeId);
        return (
          <article key={o.id} className={o.status}>
            <b>{o.status === "approved" ? "签" : o.status === "rejected" ? "退" : "草"}</b>
            <div>
              <h3>
                {o.id} · 起于 {o.originNodeId} {origin?.name ?? ""}
              </h3>
              <p>
                {o.reason} · 影响 {o.items.length} 个节点
                {o.status === "approved" && <> · 生成新版本 {o.approvedVersionId}</>}
                {o.status === "rejected" && (
                  <>
                    {" "}
                    · 退回原因：
                    {o.violations.map((v) => v.kind).join(" / ") || "人工退回"}
                  </>
                )}
                {o.status === "draft" && " · 草稿处理中"}
              </p>
              <small>{new Date(o.createdAt).toLocaleString("zh-CN")}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ---------------- 历史版本 ---------------- */

function VersionHistory({ state }: { state: ShowState }) {
  return (
    <div>
      <div className="heading">
        <div>
          <p>版本存储</p>
          <h2>签批版本留档</h2>
        </div>
      </div>
      <div className="version-list">
        {[...state.versions].reverse().map((v) => (
          <article key={v.id} className={`version-card ${v.id === state.currentVersionId ? "current" : ""}`}>
            <header>
              <b>{v.id}</b>
              {v.id === state.currentVersionId && <span className="chip">当前生效</span>}
            </header>
            <p>
              {v.number === 1 ? "初始脚本签批" : `变更 ${v.changeOrderId} · 起于 ${v.originNodeId} · ${v.reason}`}
            </p>
            <small>{new Date(v.createdAt).toLocaleString("zh-CN")}</small>
            <div className="snapshot">
              {Object.entries(v.snapshot).map(([nodeId, s]) => (
                <span key={nodeId}>
                  {nodeId} {formatMs(s.igniteMs)}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p className="hint">所有数据写入浏览器本地存储，重开页面后节点、版本与变更记录仍可查。</p>
    </div>
  );
}
