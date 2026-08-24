/**
 * 状态管理（对齐既有桥接实现）
 *
 * ★ M0 教训：sessions 字段必须真实更新（成熟桥接 的 sessions 是死字段）
 * —— refreshCounters 由上层传入真实会话数。
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface WingStatus {
  connState: "idle" | "connecting" | "connected" | "reconnecting" | "degraded" | "quarantined" | "stopped";
  outboxPending: number;
  outboxFailed: number;
  inboundPending: number;
  sessions: number;
  wsReady: boolean;
  connectedAt?: number;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
}

export function createStatusStore(file: string, now: () => number = Date.now) {
  let status: WingStatus = {
    connState: "idle",
    outboxPending: 0,
    outboxFailed: 0,
    inboundPending: 0,
    sessions: 0,
    wsReady: false,
  };
  try {
    const raw = readFileSync(file, "utf8");
    status = { ...status, ...JSON.parse(raw) };
  } catch {
    // 首次运行
  }
  const persist = () => {
    try {
      writeFileSync(file, JSON.stringify(status, null, 2), { mode: 0o600 });
    } catch {
      // 忽略
    }
  };
  return {
    get: () => ({ ...status }),
    update(patch: Partial<WingStatus>) {
      status = { ...status, ...patch };
      persist();
      return this.get();
    },
    setConn(state: WingStatus["connState"], extra?: Record<string, unknown>) {
      const patch: Partial<WingStatus> = { connState: state, ...extra };
      if (state === "connected") patch.connectedAt = now();
      status = { ...status, ...patch };
      persist();
      return this.get();
    },
    /** 刷新计数器（★ sessions 由上层传真实值，不再死字段） */
    refreshCounters(counters: { outboxPending?: number; outboxFailed?: number; inboundPending?: number; sessions?: number }) {
      status = { ...status, ...counters };
      persist();
    },
  };
}

export type StatusStore = ReturnType<typeof createStatusStore>;
