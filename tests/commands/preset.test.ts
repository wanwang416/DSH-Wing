/**
 * P1-2 /preset 命令测试（无参发预设单选卡；带参文本切换 + rotateSession）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { presetCommand } from "../../src/commands/preset.js";
import { SHIPPED_PRESETS } from "../../src/agent/preset.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

const msg = (text: string): ParsedMessage => ({
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "p2p",
  userId: "ou_1",
  text,
  rawText: text,
  mentions: [],
  timestamp: Date.now(),
});

describe("/preset", () => {
  it("带参 → setAgentPreset + rotateSession + 回执「已开新会话」", async () => {
    const setAgentPreset = vi.fn();
    const rotateSession = vi.fn(() => Promise.resolve());
    const ctx = {
      services: {
        runtime: { getAgentPreset: () => "standard", setAgentPreset },
        rotateSession,
      },
    } as BridgeCommandContext;
    const res = await presetCommand.run(ctx, "code", msg("/preset code"));
    expect(setAgentPreset).toHaveBeenCalledWith("code");
    expect(rotateSession).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("已开新会话");
  });

  it("带参且等于当前 preset → 提示无需切换，不 rotate", async () => {
    const rotateSession = vi.fn();
    const ctx = {
      services: { runtime: { getAgentPreset: () => "code", setAgentPreset: vi.fn() }, rotateSession },
    } as BridgeCommandContext;
    const res = await presetCommand.run(ctx, "code", msg("/preset code"));
    expect(res?.text).toContain("无需切换");
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("无参 → 发预设单选卡（真实 list + 当前项置灰）", async () => {
    const ctx = {
      services: {
        runtime: { getAgentPreset: () => "standard", setAgentPreset: vi.fn() },
        listPresets: async () => SHIPPED_PRESETS,
      },
    } as BridgeCommandContext;
    const res = await presetCommand.run(ctx, "", msg("/preset"));
    expect(res?.card).toBeDefined();
    const els = (res!.card!.body as any).elements as any[];
    const buttons = els.slice(2) as any[];
    expect(buttons).toHaveLength(4);
    expect(buttons[0].behaviors[0].value.op).toBe("preset:standard");
    // 当前项 standard 置灰 ✓
    expect(buttons[0].text.content).toBe("标准模式 ✓");
    expect(buttons[0].disabled).toBe(true);
  });

  it("无参且 preset 列表含 broken → 该按钮 disabled", async () => {
    const ctx = {
      services: {
        runtime: { getAgentPreset: () => "standard", setAgentPreset: vi.fn() },
        listPresets: async () => [
          ...SHIPPED_PRESETS,
          { id: "mine", label: "我的档", broken: "依赖缺失" },
        ],
      },
    } as BridgeCommandContext;
    const res = await presetCommand.run(ctx, "", msg("/preset"));
    const els = (res!.card!.body as any).elements as any[];
    const buttons = els.slice(2) as any[];
    const mine = buttons.find((b: any) => b.behaviors[0].value.op === "preset:mine");
    expect(mine.disabled).toBe(true);
  });

  it("preset 列表不可用 → 提示", async () => {
    const ctx = {
      services: { runtime: { getAgentPreset: () => "standard", setAgentPreset: vi.fn() }, listPresets: async () => [] },
    } as BridgeCommandContext;
    const res = await presetCommand.run(ctx, "", msg("/preset"));
    expect(res?.text).toContain("预设列表不可用");
  });
});
