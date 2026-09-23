// 业务规则层：节目 / 节点 / 点位模型，变更单生成、传播、校验与签批规则。
// 本文件不接触 DOM 与 localStorage，纯函数便于核对规则。

export const BEAT_TOLERANCE_MS = 80; // 音乐拍点偏差上限
export const MIN_INTERVAL_MS = 1200; // 同一点位与前发最小间隔

export type Role = "safety" | "music"; // 安全负责人 / 音乐负责人

export interface Segment {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
}

export interface Position {
  id: string;
  name: string;
  x: number; // 平面图坐标（百分比）
  y: number;
}

export interface FiringNode {
  id: string;
  segmentId: string;
  positionId: string;
  name: string;
  igniteMs: number; // 点火毫秒
  durationMs: number; // 持续毫秒
  beatMs: number; // 音乐拍点（应对齐的时间点，毫秒）
  versionId: string; // 签批版本
  executed: boolean; // 是否已执行
}

export interface ChangeItem {
  nodeId: string;
  oldIgniteMs: number;
  newIgniteMs: number;
  oldDurationMs: number;
  newDurationMs: number;
  oldBeatMs: number;
  newBeatMs: number;
  propagated: boolean; // false=直接改动的源头节点，true=沿点位传播的后续节点
}

export type ChangeOrderStatus = "draft" | "rejected" | "approved";

export interface Confirmation {
  fingerprint: string;
  at: number;
}

export interface Violation {
  nodeId: string;
  kind: "segment" | "beat" | "interval";
  message: string;
}

export interface ChangeOrder {
  id: string;
  originNodeId: string;
  reason: string;
  createdAt: number;
  status: ChangeOrderStatus;
  items: ChangeItem[];
  violations: Violation[];
  safety?: Confirmation;
  music?: Confirmation;
  approvedVersionId?: string;
  rejectedAt?: number;
}

export interface ApprovedVersion {
  id: string; // v1 / v2 ...
  number: number;
  createdAt: number;
  reason: string;
  originNodeId: string;
  changeOrderId: string;
  snapshot: Record<string, { igniteMs: number; durationMs: number; beatMs: number }>;
}

export interface ShowState {
  segments: Segment[];
  positions: Position[];
  nodes: FiringNode[];
  versions: ApprovedVersion[];
  currentVersionId: string;
  changeOrders: ChangeOrder[];
  activeDraftId: string | null;
}

// ---------- 预置数据：三段节目、六个节点、四个点位 ----------

export const SEED_SEGMENTS: Segment[] = [
  { id: "s1", name: "开场 Intro", startMs: 0, endMs: 26000 },
  { id: "s2", name: "主歌 Chorus", startMs: 26000, endMs: 78000 },
  { id: "s3", name: "终场 Finale", startMs: 78000, endMs: 120000 },
];

export const SEED_POSITIONS: Position[] = [
  { id: "A", name: "A 主舞台左", x: 16, y: 64 },
  { id: "B", name: "B 主舞台右", x: 84, y: 64 },
  { id: "C", name: "C 湖心平台", x: 50, y: 30 },
  { id: "D", name: "D 远景高架", x: 50, y: 82 },
];

export const SEED_NODES: FiringNode[] = [
  { id: "N01", segmentId: "s1", positionId: "A", name: "开场扇形架", igniteMs: 12500, durationMs: 3200, beatMs: 12480, versionId: "v1", executed: false },
  { id: "N02", segmentId: "s2", positionId: "B", name: "主歌首组礼花", igniteMs: 28800, durationMs: 4800, beatMs: 28800, versionId: "v1", executed: false },
  { id: "N03", segmentId: "s2", positionId: "C", name: "湖心烛光连发", igniteMs: 45200, durationMs: 2600, beatMs: 45160, versionId: "v1", executed: false },
  { id: "N04", segmentId: "s2", positionId: "D", name: "远景高空礼花", igniteMs: 61800, durationMs: 5200, beatMs: 61920, versionId: "v1", executed: false },
  { id: "N05", segmentId: "s3", positionId: "A", name: "终场齐射 A", igniteMs: 84200, durationMs: 6000, beatMs: 84240, versionId: "v1", executed: false },
  { id: "N06", segmentId: "s3", positionId: "B", name: "终场齐射 B", igniteMs: 87200, durationMs: 6000, beatMs: 87120, versionId: "v1", executed: false },
];

export function buildSeedState(): ShowState {
  const nodes = SEED_NODES.map((n) => ({ ...n }));
  const v1: ApprovedVersion = {
    id: "v1",
    number: 1,
    createdAt: Date.now(),
    reason: "初始脚本签批",
    originNodeId: "N01",
    changeOrderId: "",
    snapshot: Object.fromEntries(nodes.map((n) => [n.id, { igniteMs: n.igniteMs, durationMs: n.durationMs, beatMs: n.beatMs }])),
  };
  return {
    segments: SEED_SEGMENTS.map((s) => ({ ...s })),
    positions: SEED_POSITIONS.map((p) => ({ ...p })),
    nodes,
    versions: [v1],
    currentVersionId: "v1",
    changeOrders: [],
    activeDraftId: null,
  };
}

// ---------- 查询辅助 ----------

export function segmentAt(segments: Segment[], ms: number): Segment | undefined {
  return segments.find((s) => ms >= s.startMs && ms < s.endMs);
}

export function formatMs(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const milli = v % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

// 同一点位上、按点火时间排序的节点链
export function positionChain(nodes: FiringNode[], positionId: string): FiringNode[] {
  return nodes.filter((n) => n.positionId === positionId).sort((a, b) => a.igniteMs - b.igniteMs);
}

// ---------- 变更单生成与传播 ----------

// 改动已签批节点：先生成变更单，再沿同一点位后续「未执行」节点逐项传播。
export function createChangeOrder(
  state: ShowState,
  originNodeId: string,
  patch: { igniteMs: number; durationMs: number; beatMs: number },
  reason: string,
): ChangeOrder {
  const origin = state.nodes.find((n) => n.id === originNodeId)!;
  const delta = patch.igniteMs - origin.igniteMs;

  const items: ChangeItem[] = [
    {
      nodeId: origin.id,
      oldIgniteMs: origin.igniteMs,
      newIgniteMs: patch.igniteMs,
      oldDurationMs: origin.durationMs,
      newDurationMs: patch.durationMs,
      oldBeatMs: origin.beatMs,
      newBeatMs: patch.beatMs,
      propagated: false,
    },
  ];

  // 同一点位、点火时间晚于源头、且尚未执行的节点，逐项整体平移 delta
  const followers = state.nodes
    .filter((n) => n.positionId === origin.positionId && n.igniteMs > origin.igniteMs && !n.executed)
    .sort((a, b) => a.igniteMs - b.igniteMs);

  for (const f of followers) {
    items.push({
      nodeId: f.id,
      oldIgniteMs: f.igniteMs,
      newIgniteMs: f.igniteMs + delta,
      oldDurationMs: f.durationMs,
      newDurationMs: f.durationMs,
      oldBeatMs: f.beatMs,
      newBeatMs: f.beatMs + delta,
      propagated: true,
    });
  }

  const order: ChangeOrder = {
    id: "CO-" + Date.now().toString(36).toUpperCase(),
    originNodeId,
    reason: reason.trim() || "节点时间调整",
    createdAt: Date.now(),
    status: "draft",
    items,
    violations: [],
  };
  order.violations = validateOrder(order, state);
  return order;
}

// 手动调整变更单内某一项。
// 源头节点改点火时间时，同点位传播项按增量整体重平移（点火与拍点同步）；
// 源头改时长/拍点、或单独微调某个传播项，均不影响其他项。
export function updateOrderItem(
  order: ChangeOrder,
  state: ShowState,
  nodeId: string,
  patch: Partial<Pick<ChangeItem, "newIgniteMs" | "newDurationMs" | "newBeatMs">>,
): ChangeOrder {
  const origin = order.items.find((it) => !it.propagated)!;
  let items = order.items.map((it) => (it.nodeId === nodeId ? { ...it, ...patch } : it));

  if (nodeId === origin.nodeId && patch.newIgniteMs !== undefined && patch.newIgniteMs !== origin.newIgniteMs) {
    const shift = patch.newIgniteMs - origin.newIgniteMs;
    items = items.map((it) =>
      it.propagated
        ? { ...it, newIgniteMs: it.newIgniteMs + shift, newBeatMs: it.newBeatMs + shift }
        : it,
    );
  }

  const next: ChangeOrder = { ...order, items, violations: [] };
  next.violations = validateOrder(next, state);
  // 任何内容更新后，版本指纹改变，既有确认一律作废
  next.safety = undefined;
  next.music = undefined;
  return next;
}

// ---------- 三项硬性校验：越段 / 拍点偏差 / 前发间隔 ----------

export function validateOrder(order: ChangeOrder, state: ShowState): Violation[] {
  const violations: Violation[] = [];
  const byNode = new Map(state.nodes.map((n) => [n.id, n]));

  for (const item of order.items) {
    const node = byNode.get(item.nodeId)!;
    const oldSeg = segmentAt(state.segments, item.oldIgniteMs);
    const newSeg = segmentAt(state.segments, item.newIgniteMs);

    // 1. 新时间越过段落
    if (!newSeg || oldSeg?.id !== newSeg.id) {
      violations.push({
        nodeId: item.nodeId,
        kind: "segment",
        message: `${item.nodeId} 点火时间 ${formatMs(item.newIgniteMs)} 越过段落「${oldSeg?.name ?? "—"}」`,
      });
    }

    // 2. 音乐拍点偏差超过 80ms
    const beatDev = Math.abs(item.newIgniteMs - item.newBeatMs);
    if (beatDev > BEAT_TOLERANCE_MS) {
      violations.push({
        nodeId: item.nodeId,
        kind: "beat",
        message: `${item.nodeId} 与音乐拍点偏差 ${beatDev}ms，超过 ${BEAT_TOLERANCE_MS}ms`,
      });
    }

    // 3. 与同点位前发间隔短于 1.2s（前发取变更后时间；已执行节点不可被本单改动）
    const chain = positionChain(state.nodes, node.positionId);
    const idx = chain.findIndex((n) => n.id === item.nodeId);
    const prev = chain[idx - 1];
    if (prev) {
      const prevItem = order.items.find((it) => it.nodeId === prev.id);
      const prevTime = prevItem ? prevItem.newIgniteMs : prev.igniteMs;
      const gap = item.newIgniteMs - prevTime;
      if (gap < MIN_INTERVAL_MS) {
        violations.push({
          nodeId: item.nodeId,
          kind: "interval",
          message: `${item.nodeId} 与前发 ${prev.id} 间隔 ${gap}ms，短于 ${MIN_INTERVAL_MS}ms`,
        });
      }
    }
  }
  return violations;
}

// ---------- 版本指纹与双负责人确认 ----------

// 版本指纹：变更单内容的稳定摘要；内容一变指纹即变
export function fingerprint(order: ChangeOrder): string {
  const body = order.items
    .map((i) => `${i.nodeId}:${i.newIgniteMs},${i.newDurationMs},${i.newBeatMs}`)
    .join("|");
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return order.id + "#" + (h >>> 0).toString(36);
}

export function confirmBy(order: ChangeOrder, role: Role): ChangeOrder {
  const fp = fingerprint(order);
  const next = { ...order, [role]: { fingerprint: fp, at: Date.now() } } as ChangeOrder;
  return next;
}

// 任一人看到的版本（指纹）已不是当前版本，其确认作废
export function effectiveConfirmation(order: ChangeOrder, role: Role): boolean {
  const c = order[role];
  return !!c && c.fingerprint === fingerprint(order);
}

// 安全与音乐负责人对「同一版本」均确认后，方可整体签批；存在硬性违规也不得签批
export function canApprove(order: ChangeOrder): boolean {
  if (order.status !== "draft" || order.violations.length > 0) return false;
  return effectiveConfirmation(order, "safety") && effectiveConfirmation(order, "music");
}

// 整体生成新签批版本，旧版本保留；节点逐项落到新版本
export function approveOrder(state: ShowState, order: ChangeOrder): ShowState {
  if (!canApprove(order)) return state;
  const number = state.versions.length + 1;
  const version: ApprovedVersion = {
    id: "v" + number,
    number,
    createdAt: Date.now(),
    reason: order.reason,
    originNodeId: order.originNodeId,
    changeOrderId: order.id,
    snapshot: Object.fromEntries(
      state.nodes.map((n) => {
        const item = order.items.find((i) => i.nodeId === n.id);
        return item
          ? [n.id, { igniteMs: item.newIgniteMs, durationMs: item.newDurationMs, beatMs: item.newBeatMs }]
          : [n.id, { igniteMs: n.igniteMs, durationMs: n.durationMs, beatMs: n.beatMs }];
      }),
    ),
  };

  const nodes = state.nodes.map((n) => {
    const item = order.items.find((i) => i.nodeId === n.id);
    if (!item) return n;
    const seg = segmentAt(state.segments, item.newIgniteMs);
    return {
      ...n,
      igniteMs: item.newIgniteMs,
      durationMs: item.newDurationMs,
      beatMs: item.newBeatMs,
      segmentId: seg?.id ?? n.segmentId,
      versionId: version.id,
    };
  });

  const approved: ChangeOrder = { ...order, status: "approved", approvedVersionId: version.id };
  return {
    ...state,
    nodes,
    versions: [...state.versions, version],
    currentVersionId: version.id,
    changeOrders: [...state.changeOrders.filter((c) => c.id !== order.id), approved],
    activeDraftId: null,
  };
}

// 整张变更单退回：原脚本不动，仅留退回记录
export function rejectOrder(state: ShowState, order: ChangeOrder): ShowState {
  const rejected: ChangeOrder = { ...order, status: "rejected", rejectedAt: Date.now() };
  return {
    ...state,
    changeOrders: [...state.changeOrders.filter((c) => c.id !== order.id), rejected],
    activeDraftId: null,
  };
}

export function discardDraft(state: ShowState): ShowState {
  if (!state.activeDraftId) return state;
  return {
    ...state,
    changeOrders: state.changeOrders.filter((c) => c.id !== state.activeDraftId),
    activeDraftId: null,
  };
}
