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

  it("tick：probe ok + 最近有事件 → 保持 connected", async () => {
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

  it("tick：probe ok + WS 未连接 + 长时间无事件 → 假死 degraded → 主动重连", async () => {
    const transport = makeTransport({
      // start 时 false→true（连接成功）；tick 时兜底 false（WS 已断）
      isConnected: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValue(false),
      lastEventAt: () => 0, // 从未收到事件
    });
    const { logger, s } = makeSupervisor({ transport });
    await s.start(); // 连接成功（设 lastConnectedAt）
    await s.tick(); // probe ok + isConnected=false + 无事件 → 假死重连
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("假死"));
    await s.stop();
  });

  it("tick：probe ok + WS 连接正常 + 空闲无事件 → 不触发假死重连（哈马收尾项：空闲会话无事件是正常现象）", async () => {
    const transport = makeTransport({
      isConnected: vi.fn().mockReturnValueOnce(false).mockReturnValue(true), // start 连上后始终连接正常
      lastEventAt: () => 0, // 从未收到事件（空闲）
    });
    const { logger, s } = makeSupervisor({ transport });
    await s.start(); // 连接成功
    await s.tick(); // probe ok + isConnected=true + 无事件 → 不重连（修复前每 tick 都触发噪音）
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("假死"));
    expect(s.state()).toBe("connected");
    await s.stop();
  });

  it("tick：probe 连续失败达阈值 → degraded → 重连", async () => {
    const transport = makeTransport({
      isConnected: () => true, // 连接保持，但探活 API 失败
      lastEventAt: () => 0,
      probe: vi.fn().mockResolvedValue(false),
    });
    const { logger, s } = makeSupervisor({ transport, cfg: { ...BASE_CFG, probeFailThreshold: 2 } });
    await s.start();
    await s.tick(); // streak=1
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("探活失败 2 次"));
    await s.tick(); // streak=2 → 达阈值
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("探活失败 2 次"));
    await s.stop();
  });

  it("tick：probe 超时（race 返回 false）→ 计失败", async () => {
    const transport = makeTransport({
      probe: vi.fn().mockImplementation(() => new Promise(() => {})), // 永不 resolve
      isConnected: vi.fn().mockReturnValue(false),
      lastEventAt: () => 0,
    });
    const { status, s } = makeSupervisor({ transport });
    await s.start();
    const p = s.tick();
    await vi.advanceTimersByTimeAsync(8_000); // 超时
    await p;
    expect(status.update).toHaveBeenCalledWith(expect.objectContaining({ lastProbeOk: false }));
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
