/**
 * P1-2 模型管理测试（parse/formatModelSig + registry live 对象 + GUI sync 轮询）
 *
 * 核心断言：live 对象 mutate 后引用同一对象 → 已装 agent 下条回复即用新模型（对齐 成熟桥接）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseModelSig, formatModelSig, createModelRegistry, createModelSync } from "../../src/agent/model.js";

describe("parseModelSig / formatModelSig", () => {
  it("解析 provider/model", () => {
    expect(parseModelSig("deepseek/deepseek-chat")).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });
  it("非法 → undefined", () => {
    expect(parseModelSig("")).toBeUndefined();
    expect(parseModelSig("no-sep")).toBeUndefined();
    expect(parseModelSig("deepseek/")).toBeUndefined();
    expect(parseModelSig("/model")).toBeUndefined();
  });
  it("格式化（空 → 空串）", () => {
    expect(formatModelSig({ provider: "deepseek", model: "x" })).toBe("deepseek/x");
    expect(formatModelSig({ provider: "", model: "x" })).toBe("");
    expect(formatModelSig(undefined)).toBe("");
  });
});

function mkOverrides() {
  const m = new Map<string, string>();
  const set = vi.fn((chatId: string, sig: string) => void m.set(chatId, sig));
  return {
    store: {
      get: (chatId: string) => m.get(chatId),
      set,
      remove: vi.fn((chatId: string) => void m.delete(chatId)),
    },
    map: m,
  };
}

describe("createModelRegistry", () => {
  let ov: ReturnType<typeof mkOverrides>;
  beforeEach(() => {
    ov = mkOverrides();
  });

  it("无 override → liveFor 派生自 GUI 默认，惰性创建后稳定复用", () => {
    const reg = createModelRegistry({ overrides: ov.store });
    reg.setModelDefault({ provider: "deepseek", model: "default" });
    const a = reg.liveFor("oc_1");
    const b = reg.liveFor("oc_1");
    expect(a).toBe(b); // 同一 live 对象（mutate 共享）
    expect(a).toEqual({ provider: "deepseek", model: "default" });
  });

  it("setOverride → mutate live（引用同一对象，无需重建会话）+ persist override", () => {
    const reg = createModelRegistry({ overrides: ov.store });
    reg.setModelDefault({ provider: "deepseek", model: "default" });
    const live = reg.liveFor("oc_1");
    reg.setOverride("oc_1", { provider: "siliconflow", model: "qwen" });
    expect(live).toEqual({ provider: "siliconflow", model: "qwen" }); // 同一引用被 mutate
    expect(ov.store.set).toHaveBeenCalledWith("oc_1", "siliconflow/qwen");
    expect(reg.hasOverride("oc_1")).toBe(true);
  });

  it("有 override 的 chat → liveFor 直接走 override，不受 GUI 默认影响", () => {
    ov.map.set("oc_1", "glm/glm-4");
    const reg = createModelRegistry({ overrides: ov.store });
    reg.setModelDefault({ provider: "deepseek", model: "default" });
    expect(reg.liveFor("oc_1")).toEqual({ provider: "glm", model: "glm-4" });
  });

  it("setModelDefault → 刷新无 override 的 live（follower 跟随），不动有 override 的（拍板③）", () => {
    ov.map.set("oc_2", "glm/glm-4");
    const reg = createModelRegistry({ overrides: ov.store });
    reg.setModelDefault({ provider: "deepseek", model: "a" });
    const f1 = reg.liveFor("oc_1"); // follower（无 override）
    const m2 = reg.liveFor("oc_2"); // 手动 override
    reg.setModelDefault({ provider: "deepseek", model: "b" });
    expect(f1).toEqual({ provider: "deepseek", model: "b" }); // follower 跟随 GUI
    expect(m2).toEqual({ provider: "glm", model: "glm-4" }); // 手动设置不被冲
    expect(reg.getModelDefault()).toEqual({ provider: "deepseek", model: "b" });
  });

  it("clearOverride → remove + 下次 liveFor 重新派生自 GUI 默认", () => {
    ov.map.set("oc_1", "glm/glm-4");
    const reg = createModelRegistry({ overrides: ov.store });
    reg.setModelDefault({ provider: "deepseek", model: "default" });
    const live = reg.liveFor("oc_1");
    expect(live).toEqual({ provider: "glm", model: "glm-4" });
    reg.clearOverride("oc_1");
    expect(ov.store.remove).toHaveBeenCalledWith("oc_1");
    const again = reg.liveFor("oc_1");
    expect(again).toEqual({ provider: "deepseek", model: "default" }); // 重新派生
    expect(again).not.toBe(live); // 新对象
    expect(reg.hasOverride("oc_1")).toBe(false);
  });
});

describe("createModelSync", () => {
  it("首轮立即采样 → 触发 onChange（建立默认）", () => {
    const onChange = vi.fn();
    const sync = createModelSync({
      getGuiModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
      onChange,
    });
    sync.start();
    expect(onChange).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" });
    sync.stop();
  });

  it("sig 变化才触发；无变化不重复触发", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      let current: { provider: string; model: string } | undefined = { provider: "deepseek", model: "a" };
      const sync = createModelSync({
        getGuiModel: () => current,
        onChange,
        pollMs: 100,
      });
      sync.start(); // 首轮
      expect(onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(300); // 3 轮无变化
      expect(onChange).toHaveBeenCalledTimes(1);
      current = { provider: "deepseek", model: "b" };
      vi.advanceTimersByTime(100); // 变化 → 触发
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({ provider: "deepseek", model: "b" });
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("getGuiModel 返回空/抛错 → 不触发（best-effort）", () => {
    const onChange = vi.fn();
    const sync = createModelSync({
      getGuiModel: () => undefined,
      onChange,
      pollMs: 50,
    });
    sync.start();
    expect(onChange).not.toHaveBeenCalled();
    sync.stop();
  });

  it("start 幂等（重复调用不重复开 timer）；stop 后 timer 清理", () => {
    const onChange = vi.fn();
    const sync = createModelSync({
      getGuiModel: () => ({ provider: "deepseek", model: "a" }),
      onChange,
      pollMs: 50,
    });
    sync.start();
    sync.start(); // 幂等
    sync.stop();
    // 单轮样本不重复
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
