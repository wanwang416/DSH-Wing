import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnSupervisor } from "../../src/agent/turn-supervisor.js";

// 不注入 now：fake timers 推进 Date.now，注入 clock 会与 fake 时间不同步
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    timeoutMs: 600_000,
    onTimeout: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe("createTurnSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm 未超时 → 不触发 onTimeout", () => {
    const deps = makeDeps() as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.arm("oc_1");
    vi.advanceTimersByTime(1000);
    expect(deps.onTimeout).not.toHaveBeenCalled();
    ts.stop();
  });

  it("arm 超过 timeoutMs → 触发 onTimeout + warn 日志", () => {
    const deps = makeDeps({ timeoutMs: 1000 }) as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.arm("oc_1");
    vi.advanceTimersByTime(2_000);
    expect(deps.onTimeout).toHaveBeenCalledWith("oc_1");
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("轮次超时"));
    ts.stop();
  });

  it("disarm 后不触发", () => {
    const deps = makeDeps({ timeoutMs: 1000 }) as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.arm("oc_1");
    ts.disarm("oc_1");
    vi.advanceTimersByTime(2_000);
    expect(deps.onTimeout).not.toHaveBeenCalled();
    ts.stop();
  });

  it("onTimeout 抛错 → 不崩，继续扫其他 key", () => {
    const deps = makeDeps({
      timeoutMs: 1000,
      onTimeout: vi.fn((key: string) => {
        if (key === "oc_bad") throw new Error("boom");
      }),
    }) as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.arm("oc_bad");
    ts.arm("oc_good");
    vi.advanceTimersByTime(2_000);
    expect(deps.onTimeout).toHaveBeenCalledTimes(2);
    ts.stop();
  });

  it("start 幂等（重复 start 不重置 timer）", () => {
    const deps = makeDeps({ timeoutMs: 1000 }) as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.start();
    ts.arm("oc_1");
    vi.advanceTimersByTime(2_000);
    expect(deps.onTimeout).toHaveBeenCalledTimes(1);
    ts.stop();
  });

  it("stop 清空 armed 并停止扫描", () => {
    const deps = makeDeps({ timeoutMs: 1000 }) as any;
    const ts = createTurnSupervisor(deps);
    ts.start();
    ts.arm("oc_1");
    ts.stop();
    vi.advanceTimersByTime(5_000);
    expect(deps.onTimeout).not.toHaveBeenCalled();
  });
});
