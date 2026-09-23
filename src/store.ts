// ============================================================
// store.ts —— 版本存储层
// 负责：变更单生命周期、双人确认与作废、签批版本快照、
//       localStorage 持久化（浏览器重开后仍可查）、订阅通知
// 不包含任何界面代码；业务判定全部委托 rules.ts
// ============================================================

import { useSyncExternalStore } from "react";
import {
  ChangeItem,
  FireNode,
  INITIAL_NODES,
  ItemViolation,
  Role,
  buildChangeItems,
  evaluateItems,
  itemsFingerprint,
} from "./rules";

// ---------- 存储模型 ----------
export type OrderStatus = "pending" | "approved" | "returned" | "withdrawn";

export interface RoleConfirm {
  role: Role;
  proposalVersion: number; // 确认时所见的变更单版本
  at: string;
}

export interface VoidedConfirm extends RoleConfirm {
  voidedAt: string;
}

export interface ChangeOrder {
  id: string;
  createdAt: string;
  baseVersion: number; // 提出时的脚本签批版本
  anchorNodeId: string;
  anchorLabel: string;
  pointId: string;
  oldFireMs: number;
  newFireMs: number;
  deltaMs: number;
  items: ChangeItem[];
  fingerprint: string;
  proposalVersion: number; // 变更单内容版本，修改后 +1
  status: OrderStatus;
  violations: ItemViolation[]; // 退回原因（退回单）
  confirms: RoleConfirm[]; // 当前有效确认
  voidedConfirms: VoidedConfirm[]; // 因版本更新而作废的确认
  approvedVersion: number | null; // 批准后生成的签批版本号
  resolvedAt: string | null;
}

export interface NodeSnapshot {
  id: string;
  label: string;
  pointId: string;
  fireMs: number;
  durationMs: number;
  beatMs: number;
  executed: boolean;
  version: number;
}

export interface VersionSnapshot {
  version: number;
  createdAt: string;
  orderId: string | null; // 由哪张变更单产生（初始版本为 null）
  nodes: NodeSnapshot[];
}

interface Draft {
  anchorNodeId: string;
  newFireMs: number;
}

interface PersistedState {
  nodes: FireNode[];
  scriptVersion: number; // 当前签批版本
  versions: VersionSnapshot[]; // 版本档案：旧版本全部保留
  orders: ChangeOrder[]; // 变更记录
  draft: Draft | null;
  orderSeq: number;
}

// ---------- 持久化 ----------
const STORAGE_KEY = "fireworks-change-console-v1";

function initialState(): PersistedState {
  return {
    nodes: INITIAL_NODES.map((n) => ({ ...n })),
    scriptVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: new Date().toISOString(),
        orderId: null,
        nodes: INITIAL_NODES.map((n) => ({ ...n })),
      },
    ],
    orders: [],
    draft: null,
    orderSeq: 1,
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.orders)) {
      return initialState();
    }
    return parsed;
  } catch {
    return initialState();
  }
}

let state: PersistedState = loadState();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时仅保留内存态
  }
}

// ---------- 订阅 ----------
const listeners = new Set<() => void>();

function emit() {
  persist();
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): PersistedState {
  return state;
}

export function useConsoleState(): PersistedState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---------- 查询 ----------
export function activeOrder(s: PersistedState = state): ChangeOrder | null {
  return s.orders.find((o) => o.status === "pending") ?? null;
}

/** 该角色对当前变更单版本的确认是否仍然有效 */
export function hasValidConfirm(order: ChangeOrder, role: Role): boolean {
  return order.confirms.some(
    (c) => c.role === role && c.proposalVersion === order.proposalVersion
  );
}

// ---------- 动作 ----------
export function selectNodeForEdit(nodeId: string) {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node || node.executed) return;
  state = { ...state, draft: { anchorNodeId: nodeId, newFireMs: node.fireMs } };
  emit();
}

export function updateDraft(newFireMs: number) {
  if (!state.draft) return;
  state = { ...state, draft: { ...state.draft, newFireMs: Math.round(newFireMs) } };
  emit();
}

export function cancelDraft() {
  if (!state.draft) return;
  state = { ...state, draft: null };
  emit();
}

/** 提交变更单：触发退回规则则整单退回、原脚本不动；否则进入待确认 */
export function submitProposal() {
  const draft = state.draft;
  if (!draft) return;
  const anchor = state.nodes.find((n) => n.id === draft.anchorNodeId);
  if (!anchor) return;

  const items = buildChangeItems(state.nodes, anchor.id, draft.newFireMs);
  const violations = evaluateItems(state.nodes, items);
  const now = new Date().toISOString();
  const order: ChangeOrder = {
    id: `CO-${String(state.orderSeq).padStart(3, "0")}`,
    createdAt: now,
    baseVersion: state.scriptVersion,
    anchorNodeId: anchor.id,
    anchorLabel: anchor.label,
    pointId: anchor.pointId,
    oldFireMs: anchor.fireMs,
    newFireMs: draft.newFireMs,
    deltaMs: draft.newFireMs - anchor.fireMs,
    items,
    fingerprint: itemsFingerprint(items, state.scriptVersion),
    proposalVersion: 1,
    status: violations.length > 0 ? "returned" : "pending",
    violations,
    confirms: [],
    voidedConfirms: [],
    approvedVersion: null,
    resolvedAt: violations.length > 0 ? now : null,
  };
  state = {
    ...state,
    orders: [order, ...state.orders],
    orderSeq: state.orderSeq + 1,
    draft: null,
  };
  emit();
}

/** 待确认期间修改变更单：内容版本 +1，此前所有确认作废；若触发退回规则则整单退回 */
export function reviseActiveOrder(newFireMs: number) {
  const order = activeOrder();
  if (!order) return;
  const items = buildChangeItems(state.nodes, order.anchorNodeId, Math.round(newFireMs));
  const violations = evaluateItems(state.nodes, items);
  const now = new Date().toISOString();
  const voided: VoidedConfirm[] = [
    ...order.voidedConfirms,
    ...order.confirms.map((c) => ({ ...c, voidedAt: now })),
  ];
  const rejected = violations.length > 0;
  const revised: ChangeOrder = {
    ...order,
    newFireMs: Math.round(newFireMs),
    deltaMs: Math.round(newFireMs) - order.oldFireMs,
    items,
    fingerprint: itemsFingerprint(items, order.baseVersion),
    proposalVersion: order.proposalVersion + 1,
    violations,
    confirms: [],
    voidedConfirms: voided,
    status: rejected ? "returned" : order.status,
    resolvedAt: rejected ? now : order.resolvedAt,
  };
  state = {
    ...state,
    orders: state.orders.map((o) => (o.id === order.id ? revised : o)),
  };
  emit();
}

/**
 * 负责人确认：仅当确认针对当前变更单版本时有效；
 * 安全与音乐负责人对同一版本都确认后，整体生成新签批版本并保留旧版本。
 */
export function confirmRole(role: Role) {
  const order = activeOrder();
  if (!order || hasValidConfirm(order, role)) return;
  const now = new Date().toISOString();
  const confirms: RoleConfirm[] = [
    ...order.confirms.filter((c) => c.role !== role),
    { role, proposalVersion: order.proposalVersion, at: now },
  ];
  const bothConfirmed =
    hasValidConfirm({ ...order, confirms }, "safety") &&
    hasValidConfirm({ ...order, confirms }, "music");

  if (!bothConfirmed) {
    const updated: ChangeOrder = { ...order, confirms };
    state = {
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? updated : o)),
    };
    emit();
    return;
  }

  // 双确认齐全 → 生成新签批版本，旧版本留档
  const newVersion = state.scriptVersion + 1;
  const itemByNode = new Map(order.items.map((it) => [it.nodeId, it]));
  const nodes = state.nodes.map((n) => {
    const item = itemByNode.get(n.id);
    return item ? { ...n, fireMs: item.newFireMs, version: newVersion } : n;
  });
  const snapshot: VersionSnapshot = {
    version: newVersion,
    createdAt: now,
    orderId: order.id,
    nodes: nodes.map((n) => ({ ...n })),
  };
  const approved: ChangeOrder = {
    ...order,
    confirms,
    status: "approved",
    approvedVersion: newVersion,
    resolvedAt: now,
  };
  state = {
    ...state,
    nodes,
    scriptVersion: newVersion,
    versions: [...state.versions, snapshot],
    orders: state.orders.map((o) => (o.id === order.id ? approved : o)),
  };
  emit();
}

/** 撤回待确认变更单，原脚本不动 */
export function withdrawActiveOrder() {
  const order = activeOrder();
  if (!order) return;
  const now = new Date().toISOString();
  const withdrawn: ChangeOrder = { ...order, status: "withdrawn", resolvedAt: now };
  state = {
    ...state,
    orders: state.orders.map((o) => (o.id === order.id ? withdrawn : o)),
  };
  emit();
}

/** 恢复预置数据并清空存储 */
export function resetAll() {
  state = initialState();
  emit();
}
