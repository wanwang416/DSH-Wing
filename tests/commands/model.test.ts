/**
 * P1-2 /model 命令测试（无参发模型单选卡；带参文本切换 → setOverride）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { modelCommand } from "../../src/commands/model.js";
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

describe("/model", () => {
  it("带参 → setOverride(chatId, sel) + 回执「本会话模型已切换」", async () => {
    const set = vi.fn();
    const ctx = {
      services: {
        modelOverride: { has: () => false, set, clear: vi.fn() },
      },
    } as BridgeCommandContext;
    const res = await modelCommand.run(ctx, "deepseek/deepseek-chat", msg("/model deepseek/deepseek-chat"));
    expect(set).toHaveBeenCalledWith("oc_1", { provider: "deepseek", model: "deepseek-chat" });
    expect(res?.text).toContain("deepseek/deepseek-chat");
    expect(res?.text).toContain("其他会话不受影响");
  });

  it("带参非法格式 → 提示，不 set", async () => {
    const set = vi.fn();
    const ctx = { services: { modelOverride: { has: () => false, set, clear: vi.fn() } } } as BridgeCommandContext;
    const res = await modelCommand.run(ctx, "badsig", msg("/model badsig"));
    expect(res?.text).toContain("供应商/模型");
    expect(set).not.toHaveBeenCalled();
  });

  it("无参 → 发模型单选卡（含 provider 分组选项 + 当前项置灰）", async () => {
    const ctx = {
      services: {
        getModelOptions: async () => [
          { id: "deepseek/deepseek-chat", label: "DeepSeek · DeepSeek Chat" },
          { id: "deepseek/deepseek-reasoner", label: "DeepSeek · Reasoner" },
          { id: "glm/glm-4", label: "GLM · GLM-4" },
        ],
        getModel: async () => ({ provider: "deepseek", model: "deepseek-reasoner" }),
        modelOverride: { has: () => false, set: vi.fn(), clear: vi.fn() },
      },
    } as BridgeCommandContext;
    const res = await modelCommand.run(ctx, "", msg("/model"));
    expect(res?.card).toBeDefined();
    const els = (res!.card!.body as any).elements as any[];
    const buttons = els.slice(2) as any[];
    expect(buttons).toHaveLength(3);
    expect(buttons[0].behaviors[0].value.op).toBe("model:deepseek/deepseek-chat");
    // 当前项（deepseek-reasoner）置灰 ✓
    expect(buttons[1].text.content).toBe("DeepSeek · Reasoner ✓");
    expect(buttons[1].disabled).toBe(true);
  });

  it("无参且模型列表不可用 → 文本提示当前模型 + 手动用法", async () => {
    const ctx = {
      services: {
        getModelOptions: async () => [],
        getModel: async () => ({ provider: "deepseek", model: "deepseek-chat" }),
        modelOverride: { has: () => false, set: vi.fn(), clear: vi.fn() },
      },
    } as BridgeCommandContext;
    const res = await modelCommand.run(ctx, "", msg("/model"));
    expect(res?.text).toContain("deepseek/deepseek-chat");
    expect(res?.text).toContain("/model <provider>/<model>");
  });

  it("本会话已有 override → 卡片说明带「已手动指定」", async () => {
    const ctx = {
      services: {
        getModelOptions: async () => [{ id: "glm/glm-4", label: "GLM · GLM-4" }],
        getModel: async () => ({ provider: "glm", model: "glm-4" }),
        modelOverride: { has: () => true, set: vi.fn(), clear: vi.fn() },
      },
    } as BridgeCommandContext;
    const res = await modelCommand.run(ctx, "", msg("/model"));
    const title = (res!.card!.body as any).elements[0].content as string;
    expect(title).toContain("已手动指定");
  });
});
