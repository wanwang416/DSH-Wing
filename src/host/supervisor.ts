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
  /** 最近收到 WS 事件的时间（0=从未收到；连接活性检测用） */
  lastEventAt?(): number;
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
  /** 最近一次连接成功的时间（连接活性检测用） */
  let lastConnectedAt = 0;

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
      lastConnectedAt = now();
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
    // ★ 批次 3 施工项 2（G15 配套）：健康判据从"REST 探活"改为"本地状态"——
    //   isConnected()/wsReady() 在 G15 接线后是 SDK 实时值（onWsState 驱动），不再调用
    //   transport.probe()（原实现每 30s 一次真实 API GET /bot/v3/info，2,880 次/天，
    //   且 WS 假死时 HTTP 往往正常、拦不住它想拦的场景）。
    //   字段名保留 lastProbeAt/lastProbeOk（面板与前端读它），语义已改为"本地健康判定"。
    const ok = deps.transport.isConnected();
    deps.status.update({ lastProbeAt: now(), lastProbeOk: ok, wsReady: deps.transport.wsReady() });
    if (ok) {
      probeFailStreak = 0;
      if (state !== "connected") setState("connected");
      return;
    }
    // ★ 阿深 2026-10-02（验收修正）：判据换成"本地状态"后，原来两处启发式变成**死分支**——
    //   ① 原「疑似假死」检查要求 `!isConnected()`，但它位于 `if (ok)` 内，而 `ok === isConnected()`
    //      → 条件自相矛盾，永不执行；
    //   ② 原「探活失败 N 次」检查要求 `isConnected()`，而 `probeFailStreak` 只在 `!isConnected()`
    //      时递增 → 同样永不执行。
    //   （施工方把测试断言改绿的过程中，这两处死分支被掩盖成了"测试语义不符"。）
    //   按新语义收敛：连接已断（SDK 实时值）就是**事实**而非"疑似"，无需推测；连续 N 次确认后
    //   标 degraded 并走受 quota 熔断约束的重连。真实假死由 SDK watchdog（120s ping +
    //   `pingTimeout: 60`）与 onWsState 回调负责——原注释亦已声明该启发式属待删的噪音源。
    probeFailStreak += 1;
    if (probeFailStreak >= deps.cfg.probeFailThreshold) {
      setState("degraded", `WS 连接中断（连续 ${probeFailStreak} 次检测）`);
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
    /**
     * ★ 批次 3 施工项 1（G15）：SDK WS 状态回调驱动状态机——不再等 30 秒轮询发现。
     *   由 buildLarkClient 的 onWsState（onReady/onError/onReconnecting/onReconnected）调用。
     *   - ready / reconnected → 重置 reconnectAttempts 与 probeFailStreak，setState("connected")
     *   - reconnecting        → setState("reconnecting")
     *   - error               → setState("degraded", detail) 并触发 ensureConnected()
     *   不破坏 quota 熔断：error → ensureConnected 内部仍受 tripped()/quarantined 语义约束。
     */
    notifyWsState(wsState: string, detail?: string): void {
      if (stopped) return;
      if (wsState === "ready" || wsState === "reconnected") {
        reconnectAttempts = 0;
        probeFailStreak = 0;
        lastConnectedAt = now();
        if (state !== "connected") setState("connected");
        return;
      }
      if (wsState === "reconnecting") {
        if (state !== "reconnecting") setState("reconnecting", detail);
        return;
      }
      if (wsState === "error") {
        setState("degraded", detail);
        void ensureConnected().catch(() => void 0);
        return;
      }
      // 未知状态：记日志不猜（不许静默吞）
      deps.logger?.warn?.(`notifyWsState：未知 WS 状态 "${wsState}"，忽略`);
    },
    async reconnect(): Promise<void> {
      reconnectAttempts = 0;
      deps.quota.reset();
      await deps.transport.stop();
      await ensureConnected();
    },
  };
}

export type ConnectionSupervisor = ReturnType<typeof createConnectionSupervisor>;
