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
  it("无参 → 显示当前工作区 + 用法", async () => {
    const ctx = { services: { workspace: { get: () => "D:/workspace", set: vi.fn() } } } as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "", msg("/workspace"));
    expect(res?.text).toContain("D:/workspace");
    expect(res?.text).toContain("/workspace <绝对路径>");
  });

  it("带有效路径 → 切换 + rotateSession 重建", async () => {
    const set = vi.fn(() => true);
    const rotateSession = vi.fn(() => Promise.resolve());
    const ctx = {
      services: { workspace: { get: () => "D:/workspace", set }, rotateSession },
    } as BridgeCommandContext;
    const res = await workspaceCommand.run(ctx, "D:/workspace/dsh-wing", msg("/workspace D:/workspace/dsh-wing"));
    expect(set).toHaveBeenCalledWith("D:/workspace/dsh-wing");
    expect(rotateSession).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("已切换");
  });

  it("路径无效 → 提示 + 不 rotate", async () => {
    const set = vi.fn(() => false);
    const rotateSession = vi.fn();
    const ctx = {
      services: { workspace: { get: () => "D:/workspace", set }, rotateSession },
    } as BridgeCommandContext;
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
