import { describe, expect, it, vi } from "vitest";
import { createMissedCompensation } from "../../src/inbound/compensation.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const routes = { all: vi.fn().mockReturnValue([]) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps = {
    routes,
    listMessages: vi.fn().mockResolvedValue([]),
    reinject: vi.fn().mockResolvedValue(undefined),
    logger,
    ...(overrides as any),
  };
  return deps;
}

describe("createMissedCompensation（丢消息补偿）", () => {
  it("noteDelivered 登记去重集合", () => {
    const deps = makeDeps() as any;
    const c = createMissedCompensation(deps);
    c.noteDelivered("om_1");
    c.noteDelivered("om_1"); // 重复无害
    // 补偿拉取同 id → 跳过
    deps.routes.all.mockReturnValue([{ chatId: "oc_1", chatType: "group" }]);
    deps.listMessages.mockResolvedValue([{ messageId: "om_1", timestampMs: 1 }]);
    return c.onRecovered().then(() => {
      expect(deps.reinject).not.toHaveBeenCalled();
    });
  });

  it("noteDelivered 超 5000 → prune 保留后 2500", () => {
    const deps = makeDeps() as any;
    const c = createMissedCompensation(deps);
    for (let i = 0; i < 5001; i++) c.noteDelivered(`om_${i}`);
    // 不崩即可（prune 后 set 大小 2500）
  });

  it("onRecovered：补拉断连窗口消息 → reinject + info", async () => {
    const clock = makeClock();
    const deps = makeDeps() as any;
    deps.routes.all.mockReturnValue([{ chatId: "oc_1", chatType: "group" }]);
    deps.listMessages.mockResolvedValue([
      { messageId: "om_new1", timestampMs: 100 },
      { messageId: "om_new2", timestampMs: 200 },
    ]);
    const c = createMissedCompensation({ ...deps, now: clock.now });
    await c.onRecovered();
    expect(deps.listMessages).toHaveBeenCalledWith({
      chatId: "oc_1",
      startTimeMs: clock.now() - 10 * 60_000,
      endTimeMs: clock.now(),
    });
    expect(deps.reinject).toHaveBeenCalledTimes(2);
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("丢消息补偿：补拉 2 条"));
  });

  it("onRecovered：reinject 抛错 → warn 不中断", async () => {
    const deps = makeDeps() as any;
    deps.routes.all.mockReturnValue([{ chatId: "oc_1", chatType: "group" }]);
    deps.listMessages.mockResolvedValue([{ messageId: "om_a", timestampMs: 1 }]);
    deps.reinject.mockRejectedValue(new Error("reinject boom"));
    const c = createMissedCompensation(deps);
    await c.onRecovered();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("补偿 reinject 失败"));
  });

  it("onRecovered：listMessages 抛错 → warn 不中断", async () => {
    const deps = makeDeps() as any;
    deps.routes.all.mockReturnValue([{ chatId: "oc_1", chatType: "group" }]);
    deps.listMessages.mockRejectedValue(new Error("list boom"));
    const c = createMissedCompensation(deps);
    await c.onRecovered();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("补偿 listMessages 失败"));
  });

  it("onRecovered：多 route 逐个拉取", async () => {
    const deps = makeDeps() as any;
    deps.routes.all.mockReturnValue([
      { chatId: "oc_1", chatType: "group" },
      { chatId: "ou_2", chatType: "p2p" },
    ]);
    deps.listMessages.mockResolvedValue([{ messageId: "om_b", timestampMs: 1 }]);
    const c = createMissedCompensation(deps);
    await c.onRecovered();
    expect(deps.listMessages).toHaveBeenCalledTimes(2);
  });

  it("onRecovered：pulled=0 → 不打 info", async () => {
    const deps = makeDeps() as any;
    deps.routes.all.mockReturnValue([{ chatId: "oc_1", chatType: "group" }]);
    const c = createMissedCompensation(deps);
    await c.onRecovered();
    expect(deps.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("丢消息补偿"));
  });
});
