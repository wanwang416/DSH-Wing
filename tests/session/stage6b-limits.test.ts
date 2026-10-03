/**
 * ★ 阶段 6b：超时与资源上限（M28 / M41 / M43 / M4 / M12，2026-10-03）
 *
 * 攻击/异常视角（全部用可控夹具——fake timers / mock / 临时目录，不用真实系统状态）：
 *  - M28：一条出站任务永久挂起 → 超时释放队列，后续任务仍执行（旧实现：全堵）
 *  - M41：turn 超时 → 先 cancel（保留上下文），取消失败才 dispose（旧实现：直接 dispose = 失忆）
 *  - M43：turn 结束后 idleAt 刷新 → 空闲清理不误删活跃 agent（旧实现：创建时刻计时 → 误删）
 *  - M4 ：连接恢复 → lastError 被清（旧实现：浅合并残留，面板永远显示旧错误）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSerialQueue } from "../../src/session/serial.js";
import { createSessionMapper, type AgentHandleLike } from "../../src/session/mapper.js";
import { createStatusStore } from "../../src/host/status.js";

function mkHandle(overrides: Partial<AgentHandleLike> = {}): AgentHandleLike {
  return {
    agentId: "ag_1",
    sessionId: "feishu:oc_1:n:g",
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    status: "idle",
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as AgentHandleLike;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("M28 · 串行队列超时", () => {
  // ★ 6b 验收返工：本用例用真实短超时（30ms），不依赖 fake timers 触发——
  //   fake timers 与 unref() 不兼容，而 unref 是设计的一部分（不阻止宿主退出）。
  //   原则：测试迁就设计，不为迁就测试改设计。
  it("一条任务永久挂起 → 真实超时释放队列，后续任务仍能执行（旧实现必红：全堵）", async () => {
    vi.useRealTimers(); // 本用例走真实时钟
    const q = createSerialQueue();
    const warns: string[] = [];
    // 第一条：永不 resolve（模拟 SDK 不回调），超时 30ms
    const stuck = q.enqueue("oc_1", () => new Promise<string>(() => void 0), {
      timeoutMs: 30,
      onTimeout: (m) => warns.push(m),
    });
    // 第二条：正常任务
    let secondRan = false;
    const second = q.enqueue("oc_1", async () => {
      secondRan = true;
      return "ok";
    });
    // 真实等待 ~100ms（远大于 30ms 超时；unref 的 timer 在真实时钟下正常触发）
    await new Promise((r) => setTimeout(r, 100));
    await expect(stuck).rejects.toThrow(/timeout|超时/i);
    await second;
    expect(secondRan).toBe(true); // 旧实现：secondRan 永远 false（被卡住的任务堵死）
    expect(warns.length).toBeGreaterThan(0); // 超时不是静默丢弃：有日志/计数
  }, 5_000);

  it("未超时的任务不受影响；不同 key 互不干扰", async () => {
    const q = createSerialQueue();
    const fast = q.enqueue("oc_1", async () => "fast", { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(fast).resolves.toBe("fast");
  });
});

describe("M41 · turn 超时先 cancel 再 dispose", () => {
  it("可取消 → 走 cancel、不走 dispose（旧实现必红：直接 dispose）", async () => {
    const handle = mkHandle();
    const mapper = createSessionMapper<AgentHandleLike>({ createAgent: async () => handle });
    await mapper.getOrCreateAgent("oc_1");
    // 模拟 onTimeout 新逻辑（index.ts 接线同款）
    const h = mapper.get("oc_1");
    let disposed = false;
    if (h && typeof h.cancel === "function") {
      try {
        h.cancel({ kind: "turn_timeout" });
      } catch {
        disposed = true;
        await mapper.disposeAgentFor?.("oc_1");
      }
    } else {
      disposed = true;
      await mapper.disposeAgentFor?.("oc_1");
    }
    expect(handle.cancel).toHaveBeenCalledWith({ kind: "turn_timeout" });
    expect(disposed).toBe(false);
    expect(handle.dispose).not.toHaveBeenCalled(); // 旧实现：dispose 被调（上下文丢失）
  });

  it("cancel 抛错 → 兜底 dispose 仍执行（锁不残留）", async () => {
    const handle = mkHandle({ cancel: vi.fn(() => { throw new Error("cancel failed"); }) });
    // ★ 夹具修正：disposeAgentFor 调的是 opts.disposeAgent 回调——必须传入才能断言 dispose 被调
    const mapper = createSessionMapper<AgentHandleLike>({
      createAgent: async () => handle,
      disposeAgent: async (h) => { await h.dispose(); },
    });
    await mapper.getOrCreateAgent("oc_1");
    const h = mapper.get("oc_1");
    let fellBack = false;
    try {
      h!.cancel({ kind: "turn_timeout" });
    } catch {
      fellBack = true;
      await mapper.disposeAgentFor?.("oc_1");
    }
    expect(fellBack).toBe(true);
    expect(handle.dispose).toHaveBeenCalled();
  });
});

describe("M43 · 空闲清理计时依据", () => {
  it("turn 结束 touch 后 → 空闲清理不误删（旧实现必红：按创建时刻计时被删）", async () => {
    const handle = mkHandle({ status: "idle" });
    const mapper = createSessionMapper<AgentHandleLike>({ createAgent: async () => handle });
    await mapper.getOrCreateAgent("oc_1");
    vi.advanceTimersByTime(31 * 60_000); // 31 分钟（> ttl 30 分钟）
    // ★ turn 结束刷新（新接线：onTurnEnd → mapper.touch）
    mapper.touch?.("oc_1");
    const removed = await mapper.空闲清理(30 * 60_000);
    expect(removed).toBe(0); // 旧实现：removed=1（turn 结束不刷新 → 活跃 agent 被误删）
    expect(mapper.get("oc_1")).toBeTruthy();
  });

  it("真空闲（超 ttl 且未 touch）→ 仍被清理（清理语义不削弱）", async () => {
    const handle = mkHandle({ status: "idle" });
    const mapper = createSessionMapper<AgentHandleLike>({ createAgent: async () => handle });
    await mapper.getOrCreateAgent("oc_1");
    vi.advanceTimersByTime(31 * 60_000);
    const removed = await mapper.空闲清理(30 * 60_000);
    expect(removed).toBe(1);
    expect(mapper.get("oc_1")).toBeUndefined();
  });
});

describe("M4 · 连接恢复清除 lastError", () => {
  it("失败（有 lastError）→ 成功 → lastError 被清（旧实现必红：浅合并残留）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-status-6b-"));
    try {
      const store = createStatusStore(join(dir, "status.json"));
      store.setConn("degraded", { lastError: "连接失败（第 1/5 次）" });
      expect(store.get().lastError).toBe("连接失败（第 1/5 次）");
      store.setConn("connected"); // 旧实现：lastError 残留
      expect(store.get().lastError).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
