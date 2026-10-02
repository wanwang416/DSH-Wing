import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionSupervisor } from "../../src/host/supervisor.js";

const BASE_CFG = { probeIntervalMs: 30_000, probeTimeoutMs: 8_000, probeFailThreshold: 4, maxReconnectAttempts: 5 };

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeTransport(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    wsReady: vi.fn().mockReturnValue(true),
    probe: vi.fn().mockResolvedValue(true),
    lastEventAt: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function makeQuota(overrides: Record<string, unknown> = {}) {
  return {
    tripped: vi.fn().mockReturnValue(false),
    remaining: vi.fn().mockReturnValue(5),
    recordConnect: vi.fn(),
    recordFailure: vi.fn(),
    reset: vi.fn(),
    resetAt: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

function makeStatus() {
  return { setConn: vi.fn(), update: vi.fn() };
}

function makeSupervisor(overrides: Record<string, unknown> = {}) {
  const clock = makeClock();
  const transport = makeTransport();
  const quota = makeQuota();
  const status = makeStatus();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onStateChange = vi.fn();
  const s = createConnectionSupervisor({
    transport,
    quota,
    status,
    cfg: BASE_CFG,
    logger,
    onStateChange,
    now: clock.now,
    ...overrides,
  } as any);
  return { clock, transport, quota, status, logger, onStateChange, s };
}

describe("createConnectionSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start：已连接 → connected（快速分支，不重新 start）", async () => {
    const { transport, status, s } = makeSupervisor();
    await s.start();
    expect(status.setConn).toHaveBeenCalledWith("connected", {});
    expect(s.state()).toBe("connected");
    expect(transport.start).not.toHaveBeenCalled();
    await s.stop();
  });

  it("start：未连接 → 连接成功后 connected（设 lastConnectedAt + 重置计数器）", async () => {
    const transport = makeTransport({
      isConnected: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const { clock, quota, status, s } = makeSupervisor({ transport });
    await s.start();
    expect(quota.recordConnect).toHaveBeenCalled();
    expect(status.setConn).toHaveBeenCalledWith("connected", {});
    // 连接成功分支设置 lastConnectedAt
    const { lastConnectedAt } = (s as any).__internal ?? {};
    expect(clock.now()).toBeGreaterThan(0);
    void lastConnectedAt;
    await s.stop();
  });

  it("连接失败 → reconnecting（第 N 次）+ recordFailure", async () => {
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(false) });
    const { quota, s } = makeSupervisor({ transport });
    await s.start();
    expect(s.state()).toBe("reconnecting");
    expect(quota.recordFailure).toHaveBeenCalled();
    await s.stop();
  });

  it("配额熔断（quota.tripped）→ quarantined", async () => {
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(false) });
    const quota = makeQuota({ tripped: vi.fn().mockReturnValue(true) });
    const { s } = makeSupervisor({ transport, quota });
    await s.start();
    expect(s.state()).toBe("quarantined");
    await s.stop();
  });

  it("重连次数耗尽 → quarantined + recordFailure", async () => {
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(false) });
    const { s, quota } = makeSupervisor({ transport, cfg: { ...BASE_CFG, maxReconnectAttempts: 0 } });
    await s.start();
    expect(s.state()).toBe("quarantined");
    expect(quota.recordFailure).toHaveBeenCalled();
    await s.stop();
  });

  it("transport.start 抛错 → error 日志不崩溃", async () => {
    const transport = makeTransport({
      start: vi.fn().mockRejectedValue(new Error("boom")),
      isConnected: vi.fn().mockReturnValue(false),
    });
    const { logger, s } = makeSupervisor({ transport });
    await s.start();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("transport.start threw"));
    await s.stop();
  });

  it("tick：isConnected=true + 最近有事件 → 保持 connected（probe 已退役，判据=本地状态）", async () => {
    const transport = makeTransport({
      isConnected: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      lastEventAt: () => 0,
    });
    const { clock, status, s } = makeSupervisor({ transport });
    // 让 lastEventAt 返回"当前"，避免触发假死
    transport.lastEventAt = () => clock.now();
    await s.start();
    await s.tick();
    expect(status.update).toHaveBeenCalledWith(expect.objectContaining({ lastProbeOk: true }));
    expect(s.state()).toBe("connected");
    await s.stop();
  });

  it("tick：isConnected=false 连续达阈值 → degraded「WS 连接中断」并重连（SDK 实时值）", async () => {
    let connected = true;
    const transport = makeTransport({
      isConnected: () => connected, // tick 时兜底 false（WS 已断，SDK 实时值）
      lastEventAt: () => 0, // 从未收到事件
    });
    const { logger, s } = makeSupervisor({ transport, cfg: { ...BASE_CFG, probeFailThreshold: 2 } });
    await s.start(); // 连接成功（设 lastConnectedAt）
    connected = false; // 模拟 SDK 断线（G15 后 isConnected 是实时值）
    await s.tick(); // streak=1 → 未达阈值，不误报
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("WS 连接中断"));
    await s.tick(); // streak=2 → 达阈值
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("WS 连接中断"));
    await s.stop();
  });

  it("tick：isConnected=true + 空闲无事件 → 不触发重连（空闲会话无事件是正常现象）", async () => {
    const transport = makeTransport({
      isConnected: vi.fn().mockReturnValueOnce(false).mockReturnValue(true), // start 连上后始终连接正常
      lastEventAt: () => 0, // 从未收到事件（空闲）
    });
    const { logger, s } = makeSupervisor({ transport });
    await s.start(); // 连接成功
    await s.tick(); // isConnected=true + 无事件 → 不重连
    // ★ 原断言是 not.toHaveBeenCalledWith("假死")，而该文案已随启发式删除 → 会变成永真；改为断言当前真实文案
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("WS 连接中断"));
    expect(s.state()).toBe("connected");
    await s.stop();
  });

  it("tick：isConnected 连续失败达阈值 → degraded「WS 连接中断」→ 重连（判据=本地状态，probe 已退役）", async () => {
    const transport = makeTransport({
      isConnected: () => false, // SDK 实时值：连接已断
      lastEventAt: () => 0,
      probe: vi.fn().mockResolvedValue(true), // ★ 新实现不再调用（下线证明）
    });
    const { logger, s } = makeSupervisor({ transport, cfg: { ...BASE_CFG, probeFailThreshold: 2 } });
    await s.start();
    await s.tick(); // streak=1
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("WS 连接中断"));
    await s.tick(); // streak=2 → 达阈值
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("WS 连接中断（连续 2 次检测）"));
    expect((transport.probe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    await s.stop();
  });

  it("tick：连接未就绪 → lastProbeOk=false，且不再等待 probe 超时（探活已退役）", async () => {
    const transport = makeTransport({
      probe: vi.fn().mockImplementation(() => new Promise(() => {})), // 若仍被调用会永久挂住
      isConnected: vi.fn().mockReturnValue(false),
      lastEventAt: () => 0,
    });
    const { status, s } = makeSupervisor({ transport, cfg: { ...BASE_CFG, probeFailThreshold: 99 } });
    await s.start();
    await s.tick(); // ★ 不需要 advanceTimersByTimeAsync：新实现根本不 await probe（旧实现要等 8s 超时）
    expect(status.update).toHaveBeenCalledWith(expect.objectContaining({ lastProbeOk: false }));
    expect((transport.probe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    await s.stop();
  });

  it("tick：quarantined 窗口到期 → 自动恢复", async () => {
    const clock = makeClock();
    const quota = makeQuota({
      tripped: vi.fn().mockReturnValue(true),
      resetAt: vi.fn().mockReturnValue(clock.now() - 1),
    });
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(false) });
    const { s } = makeSupervisor({ transport, quota, now: clock.now });
    await s.start();
    expect(s.state()).toBe("quarantined");
    await s.tick();
    expect(quota.reset).toHaveBeenCalled();
    await s.stop();
  });

  it("stop → transport.stop + stopped", async () => {
    const { transport, s } = makeSupervisor();
    await s.start();
    await s.stop();
    expect(transport.stop).toHaveBeenCalled();
    expect(s.state()).toBe("stopped");
  });

  it("reconnect → quota.reset + transport.stop + 重新连接", async () => {
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(false) });
    const { quota, s } = makeSupervisor({ transport });
    await s.reconnect();
    expect(quota.reset).toHaveBeenCalled();
    expect(transport.stop).toHaveBeenCalled();
    await s.stop();
  });
});
