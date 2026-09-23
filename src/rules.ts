// ============================================================
// rules.ts —— 业务规则层（纯函数，不依赖界面与存储）
// 预置数据：3 段节目 / 4 个点位 / 6 个节点
// 规则：传播、跨段、拍点偏差、前发间隔、签批判定
// ============================================================

// ---------- 规则常量 ----------
export const BEAT_TOLERANCE_MS = 80; // 音乐拍点允许偏差 ±80ms
export const MIN_GAP_MS = 1200; // 同点位与前一发最小间隔 1.2s

// ---------- 领域模型 ----------
export interface Segment {
  id: string;
  name: string;
  startMs: number;
  endMs: number; // 右开区间，最后一段右闭
}

export interface LaunchPoint {
  id: string;
  name: string;
  x: number; // 平面图百分比坐标
  y: number;
}

/** 校验与传播所需的最小节点结构（历史版本快照同样满足） */
export interface NodeLike {
  id: string;
  label: string;
  pointId: string;
  fireMs: number;
  beatMs: number;
  durationMs: number;
  executed: boolean;
}

export interface FireNode extends NodeLike {
  segmentId: string;
  version: number; // 节点当前签批版本
}

export type Role = "safety" | "music";

export const ROLES: { id: Role; name: string }[] = [
  { id: "safety", name: "安全负责人" },
  { id: "music", name: "音乐负责人" },
];

export const ROLE_NAME: Record<Role, string> = {
  safety: "安全负责人",
  music: "音乐负责人",
};

// ---------- 预置数据 ----------
export const SEGMENTS: Segment[] = [
  { id: "seg-intro", name: "序章 Intro", startMs: 0, endMs: 75000 },
  { id: "seg-chorus", name: "主歌 Chorus", startMs: 75000, endMs: 200000 },
  { id: "seg-finale", name: "终章 Finale", startMs: 200000, endMs: 260000 },
];

export const TOTAL_MS = SEGMENTS[SEGMENTS.length - 1].endMs;

export const POINTS: LaunchPoint[] = [
  { id: "pt-a", name: "A 点位", x: 18, y: 26 },
  { id: "pt-b", name: "B 点位", x: 74, y: 20 },
  { id: "pt-c", name: "C 点位", x: 30, y: 72 },
  { id: "pt-d", name: "D 点位", x: 80, y: 66 },
];

export const INITIAL_NODES: FireNode[] = [
  { id: "n1", label: "N1 开场齐射", pointId: "pt-a", segmentId: "seg-intro", fireMs: 12500, durationMs: 3000, beatMs: 12500, executed: true, version: 1 },
  { id: "n2", label: "N2 银柳升空", pointId: "pt-a", segmentId: "seg-intro", fireMs: 42000, durationMs: 4000, beatMs: 42000, executed: false, version: 1 },
  { id: "n3", label: "N3 蓝菊礼花", pointId: "pt-b", segmentId: "seg-chorus", fireMs: 96000, durationMs: 3500, beatMs: 96000, executed: false, version: 1 },
  { id: "n4", label: "N4 红牡丹礼花", pointId: "pt-c", segmentId: "seg-chorus", fireMs: 150000, durationMs: 5000, beatMs: 150000, executed: false, version: 1 },
  { id: "n5", label: "N5 扇形银尾", pointId: "pt-a", segmentId: "seg-chorus", fireMs: 182000, durationMs: 4500, beatMs: 182000, executed: false, version: 1 },
  { id: "n6", label: "N6 终章金冠", pointId: "pt-d", segmentId: "seg-finale", fireMs: 230000, durationMs: 6000, beatMs: 230000, executed: false, version: 1 },
];

// ---------- 基础工具 ----------
export function formatMs(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(Math.round(ms));
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const milli = abs % 1000;
  return `${sign}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function formatDelta(deltaMs: number): string {
  if (deltaMs === 0) return "±0ms";
  return `${deltaMs > 0 ? "+" : "−"}${Math.abs(Math.round(deltaMs))}ms`;
}

export function segmentOf(ms: number): Segment | null {
  for (const seg of SEGMENTS) {
    if (ms >= seg.startMs && ms < seg.endMs) return seg;
  }
  const last = SEGMENTS[SEGMENTS.length - 1];
  return ms === last.endMs ? last : null;
}

export function pointName(pointId: string): string {
  return POINTS.find((p) => p.id === pointId)?.name ?? pointId;
}

export function segmentName(segmentId: string): string {
  return SEGMENTS.find((s) => s.id === segmentId)?.name ?? segmentId;
}

// ---------- 变更项与传播 ----------
export interface ChangeItem {
  nodeId: string;
  label: string;
  pointId: string;
  oldFireMs: number;
  newFireMs: number;
  deltaMs: number;
  beatMs: number;
  durationMs: number;
  kind: "anchor" | "propagated";
}

/**
 * 传播规则：锚点节点时间变化后，沿同一点位后续未执行节点逐项平移相同偏移；
 * 已执行节点与其他点位不受影响。
 */
export function buildChangeItems(
  nodes: NodeLike[],
  anchorId: string,
  newFireMs: number
): ChangeItem[] {
  const anchor = nodes.find((n) => n.id === anchorId);
  if (!anchor) return [];
  const delta = Math.round(newFireMs) - anchor.fireMs;
  return nodes
    .filter(
      (n) =>
        n.pointId === anchor.pointId &&
        !n.executed &&
        (n.id === anchor.id || n.fireMs > anchor.fireMs)
    )
    .sort((a, b) => a.fireMs - b.fireMs)
    .map((n) => ({
      nodeId: n.id,
      label: n.label,
      pointId: n.pointId,
      oldFireMs: n.fireMs,
      newFireMs: n.fireMs + delta,
      deltaMs: delta,
      beatMs: n.beatMs,
      durationMs: n.durationMs,
      kind: n.id === anchor.id ? ("anchor" as const) : ("propagated" as const),
    }));
}

// ---------- 三项退回校验 ----------
export interface ItemCheck {
  nodeId: string;
  label: string;
  kind: "anchor" | "propagated";
  newFireMs: number;
  crossSegment: boolean; // 新时间越过段落边界
  beatDevMs: number; // 与音乐拍点的偏差绝对值
  beatViolation: boolean; // 偏差超过 80ms
  prevLabel: string | null; // 同点位前一发
  prevFireMs: number | null;
  gapMs: number | null;
  gapViolation: boolean; // 与前发间隔短于 1.2s
}

export interface ItemViolation {
  nodeId: string;
  label: string;
  reasons: string[];
}

/**
 * 逐项检查变更项：
 * 1) 新时间越过段落（或超出整场范围）
 * 2) 音乐拍点偏差超过 80ms
 * 3) 与同点位前一发（变更生效后的最近一发）间隔短于 1.2s
 */
export function inspectItems(nodes: NodeLike[], items: ChangeItem[]): ItemCheck[] {
  const itemByNode = new Map(items.map((it) => [it.nodeId, it]));
  return items.map((item) => {
    const node = nodes.find((n) => n.id === item.nodeId);
    const oldSeg = node ? segmentOf(node.fireMs) : null;
    const newSeg = segmentOf(item.newFireMs);
    const crossSegment = !newSeg || !oldSeg || oldSeg.id !== newSeg.id;

    const beatDevMs = Math.abs(item.newFireMs - item.beatMs);
    const beatViolation = beatDevMs > BEAT_TOLERANCE_MS;

    // 同点位所有发次（变更生效后的时间），找该发之前最近的一发
    const launches = nodes
      .filter((n) => n.pointId === item.pointId)
      .map((n) => {
        const changed = itemByNode.get(n.id);
        return { id: n.id, label: n.label, ms: changed ? changed.newFireMs : n.fireMs };
      })
      .sort((a, b) => a.ms - b.ms);
    const idx = launches.findIndex((l) => l.id === item.nodeId);
    const prev = idx > 0 ? launches[idx - 1] : null;
    const gapMs = prev ? item.newFireMs - prev.ms : null;
    const gapViolation = gapMs !== null && gapMs < MIN_GAP_MS;

    return {
      nodeId: item.nodeId,
      label: item.label,
      kind: item.kind,
      newFireMs: item.newFireMs,
      crossSegment,
      beatDevMs,
      beatViolation,
      prevLabel: prev ? prev.label : null,
      prevFireMs: prev ? prev.ms : null,
      gapMs,
      gapViolation,
    };
  });
}

/** 任一变更项触发任一规则 → 整张变更单退回 */
export function evaluateItems(nodes: NodeLike[], items: ChangeItem[]): ItemViolation[] {
  return inspectItems(nodes, items)
    .map((c) => {
      const reasons: string[] = [];
      if (c.crossSegment) reasons.push("新时间越过段落边界");
      if (c.beatViolation)
        reasons.push(`音乐拍点偏差 ${Math.round(c.beatDevMs)}ms > ${BEAT_TOLERANCE_MS}ms`);
      if (c.gapViolation)
        reasons.push(
          `与前发 ${c.prevLabel ?? ""} 间隔 ${Math.round(c.gapMs ?? 0)}ms < ${MIN_GAP_MS}ms`
        );
      return { nodeId: c.nodeId, label: c.label, reasons };
    })
    .filter((v) => v.reasons.length > 0);
}

// ---------- 签批版本判定 ----------
/** 变更单内容指纹：基线版本 + 逐项（节点/旧时间/新时间），用于识别“版本已更新” */
export function itemsFingerprint(items: ChangeItem[], baseVersion: number): string {
  const body = items
    .map((it) => `${it.nodeId}:${it.oldFireMs}->${it.newFireMs}`)
    .join("|");
  return `v${baseVersion}#${body}`;
}
