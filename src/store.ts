// 版本存储层：localStorage 持久化 + React 状态管理。
// 浏览器重开后，节点、签批版本与变更记录仍可查。
// 本文件只管存取与状态流转，业务判定全部委托 rules.ts。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChangeOrder,
  type Role,
  type ShowState,
  approveOrder,
  buildSeedState,
  confirmBy,
  createChangeOrder,
  discardDraft,
  rejectOrder,
  updateOrderItem,
} from "./rules";

const STORAGE_KEY = "hxyfront-62008-change-console-v1";

function loadState(): ShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ShowState;
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.versions)) {
        return parsed;
      }
    }
  } catch {
    // 存储损坏时回落到预置数据
  }
  return buildSeedState();
}

export function useShowStore() {
  const [state, setState] = useState<ShowState>(loadState);
  const writeTimer = useRef<number | null>(null);

  useEffect(() => {
    // 微延迟写入，避免连续编辑频繁落盘
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, 120);
    return () => {
      if (writeTimer.current) window.clearTimeout(writeTimer.current);
    };
  }, [state]);

  const openChange = useCallback(
    (nodeId: string, patch: { igniteMs: number; durationMs: number; beatMs: number }, reason: string) => {
      setState((prev) => {
        if (prev.activeDraftId) return prev; // 同时只处理一张变更单
        const order = createChangeOrder(prev, nodeId, patch, reason);
        return { ...prev, changeOrders: [...prev.changeOrders, order], activeDraftId: order.id };
      });
    },
    [],
  );

  const editItem = useCallback((nodeId: string, patch: { newIgniteMs?: number; newDurationMs?: number; newBeatMs?: number }) => {
    setState((prev) => {
      const order = prev.changeOrders.find((c) => c.id === prev.activeDraftId);
      if (!order || order.status !== "draft") return prev;
      const updated = updateOrderItem(order, prev, nodeId, patch);
      return { ...prev, changeOrders: prev.changeOrders.map((c) => (c.id === order.id ? updated : c)) };
    });
  }, []);

  const confirm = useCallback((role: Role) => {
    setState((prev) => {
      const order = prev.changeOrders.find((c) => c.id === prev.activeDraftId);
      if (!order || order.status !== "draft" || order.violations.length > 0) return prev;
      const updated = confirmBy(order, role);
      return { ...prev, changeOrders: prev.changeOrders.map((c) => (c.id === order.id ? updated : c)) };
    });
  }, []);

  const approve = useCallback(() => {
    setState((prev) => {
      const order = prev.changeOrders.find((c) => c.id === prev.activeDraftId);
      return order ? approveOrder(prev, order) : prev;
    });
  }, []);

  const reject = useCallback(() => {
    setState((prev) => {
      const order = prev.changeOrders.find((c) => c.id === prev.activeDraftId);
      return order ? rejectOrder(prev, order) : prev;
    });
  }, []);

  const cancelDraft = useCallback(() => {
    setState((prev) => discardDraft(prev));
  }, []);

  const resetAll = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState(buildSeedState());
  }, []);

  // 模拟演出推进：已执行节点不能改动，也不接收变更传播
  const toggleExecuted = useCallback((nodeId: string) => {
    setState((prev) => {
      if (prev.activeDraftId) return prev;
      return { ...prev, nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, executed: !n.executed } : n)) };
    });
  }, []);

  return { state, openChange, editItem, confirm, approve, reject, cancelDraft, resetAll, toggleExecuted };
}
