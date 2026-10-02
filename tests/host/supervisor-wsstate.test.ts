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

function makeStatus() {
  return { setConn: vi.fn(), update: vi.fn(), get: vi.fn().mockReturnValue({}) };
}

function makeSupervisor(transportOverrides: Record<string, unknown> = {}, depsOverrides: Record<string, unknown> = {}) {
  const transport = makeTransport(transportOverrides);
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
    ...depsOverrides,
  } as any);
  return { transport, quota, status, logger, onStateChange, s };
}

describe("supervisor.notifyWsState（批次 3 施工项 1：G15 SDK 状态回调驱动状态机）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("notifyWsState(\"reconnecting\") → state 变 reconnecting", async () => {
    const { s } = makeSupervisor();
    await s.start();
    s.notifyWsState("reconnecting");
    expect(s.state()).toBe("reconnecting");
    await s.stop();
  });

  it("notifyWsState(\"ready\"/\"reconnected\") → connected 且 reconnectAttempts 归零（重连成功后可再重连）", async () => {
    let connected = false;
    const transport = makeTransport({ isConnected: () => connected });
    const { s, onStateChange } = makeSupervisor({}, { transport });
    await s.start(); // connected=false → connecting → reconnecting（attempts=1）
    expect(s.state()).toBe("reconnecting");
    // SDK 报告重连成功
    s.notifyWsState("reconnected");
    expect(s.state()).toBe("connected");
    expect(onStateChange).toHaveBeenCalledWith("connected", undefined);
    // ★ reconnectAttempts 归零的证据：再次 error → ensureConnected 从 0 起算（不会 quarantined）
    connected = false;
    s.notifyWsState("error", "boom");
    await vi.waitFor(() => expect(s.state()).toBe("reconnecting")); // ensureConnected 重新走起
    expect(s.state()).not.toBe("quarantined");
    await s.stop();
  });

  it("notifyWsState(\"error\", detail) → degraded 且 detail 落到 status（lastError）", async () => {
    let connected = false;
    const transport = makeTransport({ isConnected: () => connected });
    const { s, status } = makeSupervisor({}, { transport });
    await s.start();
    s.notifyWsState("error", "WS 断开：read ECONNRESET");
    expect(status.setConn).toHaveBeenCalledWith("degraded", { lastError: "WS 断开：read ECONNRESET" });
    await s.stop();
  });

  it("notifyWsState(\"error\") 会触发 ensureConnected（尝试自愈）", async () => {
    let connected = false;
    const transport = makeTransport({ isConnected: () => connected });
    const { s } = makeSupervisor({}, { transport });
    await s.start(); // start 内 1 次 transport.start
    const startCalls = (transport.start as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(startCalls).toBe(1);
    s.notifyWsState("error", "boom"); // → degraded → ensureConnected → transport.start 第 2 次
    await vi.waitFor(() => expect((transport.start as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
    await s.stop();
  });

  it("notifyWsState 不破坏 quota 熔断：tripped 时 error 不重连，保持 quarantined", () => {
    const s2 = createConnectionSupervisor({
      transport: makeTransport({ isConnected: () => false }),
      quota: makeQuota({ tripped: () => true }),
      status: makeStatus(),
      cfg: BASE_CFG,
    } as any);
    s2.notifyWsState("error", "boom");
    // ensureConnected 内部 quota.tripped() → quarantined（熔断语义未被 notifyWsState 破坏）
    return vi.waitFor(() => expect(s2.state()).toBe("quarantined"));
  });
});

describe("transport.isConnected 动态读 SDK（G15 第二半）", () => {
  it("client.isWsReady() 返回 false → transport.isConnected() 必须为 false（旧实现恒为启动快照 → 红）", async () => {
    const { createTransport } = await import("../../src/host/websocket.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wing-ws-g15-"));
    const isWsReady = vi.fn().mockReturnValue(true);
    const client = {
      on: vi.fn(),
      ws: { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) },
      isWsReady,
    };
    const t = createTransport({
      getClient: () => client,
      onMessage: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      lockDir: join(dir, "lock"),
    } as any);
    await t.start();
    expect(t.isConnected()).toBe(true); // 启动时 SDK 已 ready
    // SDK 断线（isWsReady → false）：isConnected 必须跟着变
    isWsReady.mockReturnValue(false);
    expect(t.isConnected()).toBe(false);
    expect(t.wsReady()).toBe(false);
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
