/**
 * P1-3 /workspace 命令测试（显示/切换工作区）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { workspaceCommand } from "../../src/commands/workspace.js";
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

describe("/workspace", () => {
  it("无参 → 显示当前会话工作区 + 用法（★M39 per-chat：get 带 chatId）", async () => {
    const ctx = { services: { workspace: { get: vi.fn(() => "D:/workspace"), set: vi.fn() } } } as unknown as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "", msg("/workspace"));
    expect(res?.text).toContain("D:/workspace");
    expect(res?.text).toContain("/workspace <绝对路径>");
    expect((ctx.services!.workspace as any).get).toHaveBeenCalledWith("oc_1");
  });

  it("带有效路径 → 切换 + rotateSession 重建（★M39 per-chat：set 带 chatId，回执写明仅本会话生效）", async () => {
    const set = vi.fn(() => true);
    const rotateSession = vi.fn(() => Promise.resolve());
    const ctx = {
      services: { workspace: { get: vi.fn(() => "D:/workspace"), set }, rotateSession },
    } as unknown as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "D:/workspace/dsh-wing", msg("/workspace D:/workspace/dsh-wing"));
    expect(set).toHaveBeenCalledWith("oc_1", "D:/workspace/dsh-wing"); // per-chat：只写本会话 override
    expect(rotateSession).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("已切换");
    expect(res?.text).toContain("仅本会话生效"); // 影响面明确告知
    expect(res?.text).not.toContain("所有会话");
  });

  it("路径无效 → 提示 + 不 rotate", async () => {
    const set = vi.fn(() => false);
    const rotateSession = vi.fn();
    const ctx = {
      services: { workspace: { get: vi.fn(() => "D:/workspace"), set }, rotateSession },
    } as unknown as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "D:/nope", msg("/workspace D:/nope"));
    expect(res?.text).toContain("路径无效或不存在");
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("服务不可用 → 提示", async () => {
    const ctx = {} as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "", msg("/workspace"));
    expect(res?.text).toContain("工作区服务不可用");
  });
});
