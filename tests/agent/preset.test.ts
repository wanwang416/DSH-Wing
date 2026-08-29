/**
 * P1-2 preset 管理测试（listPresets 真实 roster + 兜底 4 档；presetLabel）
 */
import { describe, expect, it, vi } from "vitest";
import { listPresets, presetLabel, SHIPPED_PRESETS } from "../../src/agent/preset.js";

describe("SHIPPED_PRESETS", () => {
  it("出厂 4 档（standard/code/minimal/cordis，ALAN 拍板①）", () => {
    expect(SHIPPED_PRESETS.map((p) => p.id)).toEqual(["standard", "code", "minimal", "cordis"]);
  });
});

describe("listPresets", () => {
  it("有 agentPresets.list → 映射真实 roster（含 user 档、broken）", async () => {
    const ctx = {
      get: (name: string) =>
        name === "agentPresets"
          ? {
              list: async () => [
                { id: "standard", trust: "system", name: "标准模式", description: "全能", broken: undefined },
                { id: "mine", trust: "user", name: "我的私有档", description: "自定义" },
                { id: "broken1", trust: "user", name: "坏档", description: "x", broken: "缺少依赖" },
              ],
            }
          : undefined,
    };
    const ps = await listPresets(ctx as any);
    expect(ps).toHaveLength(3);
    expect(ps[0]).toEqual({ id: "standard", label: "标准模式", trust: "system", desc: "全能" });
    expect(ps[1].trust).toBe("user");
    expect(ps[2].broken).toBe("缺少依赖");
  });

  it("无 agentPresets 服务 → 兜底 4 档", async () => {
    const ps = await listPresets({ get: () => undefined } as any);
    expect(ps).toEqual(SHIPPED_PRESETS);
  });

  it("list() 抛错 → 兜底 4 档 + warn 日志", async () => {
    const warn = vi.fn();
    const ctx = {
      get: () => ({ list: async () => { throw new Error("boom"); } }),
    };
    const ps = await listPresets(ctx as any, { warn });
    expect(ps).toEqual(SHIPPED_PRESETS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agentPresets.list() 失败"));
  });

  it("服务存在但返回空数组 → 空数组（上层可自行 fallback）", async () => {
    const ctx = { get: () => ({ list: async () => [] }) };
    const ps = await listPresets(ctx as any);
    expect(ps).toEqual([]);
  });
});

describe("presetLabel", () => {
  it("找到 → 返回中文名；找不到 → 原 id", () => {
    expect(presetLabel("code", SHIPPED_PRESETS)).toBe("PTC 模式");
    expect(presetLabel("nope", SHIPPED_PRESETS)).toBe("nope");
    expect(presetLabel("code", [])).toBe("code");
  });
});
