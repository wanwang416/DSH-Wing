import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createConnectionSupervisor } from "../../src/host/supervisor.js";

const BASE_CFG = { probeIntervalMs: 30_000, probeTimeoutMs: 8_000, probeFailThreshold: 4, maxReconnectAttempts: 5 };

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

describe("supervisor tick：健康判据从 REST 探活改为本地状态（批次 3 施工项 2）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tick 不再调用 transport.probe（新实现本地判定，probe 桩永不调用 → 旧实现每 tick 都调 → 红）", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const transport = makeTransport({ probe });
    const s = createConnectionSupervisor({
      transport,
      quota: makeQuota(),
      status: { setConn: vi.fn(), update: vi.fn(), get: vi.fn().mockReturnValue({}) },
      cfg: BASE_CFG,
    } as any);
    await s.start();
    await s.tick();
    await s.tick();
    await s.tick();
    expect(probe).not.toHaveBeenCalled();
    await s.stop();
  });

  it("isConnected=false → tick 后走失败链：lastProbeOk=false + wsReady=false 落到 status", async () => {
    const transport = makeTransport({
      isConnected: vi.fn().mockReturnValue(false),
      wsReady: vi.fn().mockReturnValue(false),
    });
    const quota = makeQuota();
    const status = { setConn: vi.fn(), update: vi.fn(), get: vi.fn().mockReturnValue({}) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const s = createConnectionSupervisor({
      transport,
      quota,
      status,
      cfg: BASE_CFG,
      logger,
    } as any);
    await s.start(); // start 时 isConnected=false → ensureConnected → reconnecting
    expect(s.state()).toBe("reconnecting");
    // tick：本地判定 isConnected=false → status.update({lastProbeOk:false, wsReady:false}) → probeFailStreak++
    await s.tick();
    await s.tick();
    expect(status.update).toHaveBeenCalledWith(
      expect.objectContaining({ lastProbeOk: false, wsReady: false }),
    );
    expect(s.state()).toBe("reconnecting");
    await s.stop();
  });

  it("isConnected=true → tick 不重连（防误重连，基底 ADR-2 原意），字段名保留 lastProbeAt/lastProbeOk", async () => {
    const transport = makeTransport({ isConnected: vi.fn().mockReturnValue(true) });
    const status = { setConn: vi.fn(), update: vi.fn(), get: vi.fn().mockReturnValue({}) };
    const s = createConnectionSupervisor({
      transport,
      quota: makeQuota(),
      status,
      cfg: BASE_CFG,
    } as any);
    await s.start();
    await s.tick();
    expect((transport.start as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1); // start 时至多 1 次，tick 不再触发
    expect(status.update).toHaveBeenCalledWith(
      expect.objectContaining({ lastProbeAt: expect.any(Number), lastProbeOk: true, wsReady: true }),
    );
    await s.stop();
  });
});
