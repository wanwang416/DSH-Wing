/**
 * 连接监督器（对齐既有桥接实现）
 *
 * 状态机：idle → connecting → connected / reconnecting / degraded / quarantined / stopped
 * - probe：定期真实 API 探活（检测 WS 假死）→ 失败 streak → degraded → 重连
 * - quota：窗口熔断（失败过多 → quarantined，窗口过期自动恢复）
 * - ★ 这是 WS 假死根因的解决（M1 保留项能否真机验证就靠它）
 */

import type { QuotaGovernor } from "./quota.js";
import type { StatusStore } from "./status.js";

export interface TransportLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  wsReady(): boolean;
  probe(): Promise<boolean>;
}

export interface SupervisorCfg {
  probeIntervalMs: number;
  probeTimeoutMs: number;
  probeFailThreshold: number;
  maxReconnectAttempts: number;
}

export interface SupervisorDeps {
  transport: TransportLike;
  quota: QuotaGovernor;
  status: StatusStore;
  cfg: SupervisorCfg;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  onStateChange?(state: string, detail?: string): void;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createConnectionSupervisor(deps: SupervisorDeps) {
  const now = deps.now ?? Date.now;
  let state: string = "idle";
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let probeFailStreak = 0;
  let reconnectAttempts = 0;

  const setState = (s: string, detail?: string) => {
    state = s;
    deps.status.setConn(s as never, detail ? { lastError: detail } : {});
    deps.onStateChange?.(s, detail);
    if (detail) deps.logger?.warn?.(`conn -> ${s}: ${detail}`);
    else deps.logger?.info?.(`conn -> ${s}`);
  };

  async function ensureConnected(): Promise<void> {
    if (stopped) return;
    if (deps.transport.isConnected()) {
      if (state !== "connected") setState("connected");
      return;
    }
    if (state === "quarantined") return;
    if (deps.quota.tripped()) {
      setState("quarantined", `配额熔断（${deps.quota.remaining() === 0 ? "已超限" : "窗口内失败过多"}）`);
      return;
    }
    if (reconnectAttempts >= deps.cfg.maxReconnectAttempts) {
      deps.quota.recordFailure();
      setState("quarantined", `重连次数耗尽（${reconnectAttempts}）`);
      return;
    }
    setState("connecting");
    deps.quota.recordConnect();
    try {
      await deps.transport.start();
    } catch (err) {
      deps.logger?.error?.(`transport.start threw: ${String(err)}`);
    }
    if (deps.transport.isConnected()) {
      reconnectAttempts = 0;
      probeFailStreak = 0;
      setState("connected");
    } else {
      reconnectAttempts += 1;
      deps.quota.recordFailure();
      if (deps.quota.tripped()) {
        setState("quarantined", `配额熔断（重连 ${reconnectAttempts} 次失败）`);
        return;
      }
      setState("reconnecting", `连接失败（第 ${reconnectAttempts}/${deps.cfg.maxReconnectAttempts} 次）`);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (state === "quarantined") {
      const liftAt = deps.quota.resetAt();
      if (liftAt === undefined || now() >= liftAt) {
        deps.logger?.info?.("配额窗口重置——自动恢复");
        deps.quota.reset();
        reconnectAttempts = 0;
        state = "reconnecting";
        await ensureConnected();
      }
      return;
    }
    let ok = false;
    try {
      ok = await Promise.race([deps.transport.probe(), sleep(deps.cfg.probeTimeoutMs).then(() => false)]);
    } catch {
      ok = false;
    }
    deps.status.update({ lastProbeAt: now(), lastProbeOk: ok, wsReady: deps.transport.wsReady() });
    if (ok) {
      probeFailStreak = 0;
      if (!deps.transport.isConnected()) {
        reconnectAttempts = 0;
        await ensureConnected();
      } else if (state !== "connected") setState("connected");
      return;
    }
    probeFailStreak += 1;
    if (probeFailStreak >= deps.cfg.probeFailThreshold) {
      if (deps.transport.isConnected()) setState("degraded", `探活失败 ${probeFailStreak} 次`);
      await ensureConnected();
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      setState("connecting");
      await ensureConnected();
      timer = setInterval(() => void tick(), deps.cfg.probeIntervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await deps.transport.stop();
      setState("stopped");
    },
    async tick(): Promise<void> {
      await tick();
    },
    state: () => state,
    async reconnect(): Promise<void> {
      reconnectAttempts = 0;
      deps.quota.reset();
      await deps.transport.stop();
      await ensureConnected();
    },
  };
}

export type ConnectionSupervisor = ReturnType<typeof createConnectionSupervisor>;
