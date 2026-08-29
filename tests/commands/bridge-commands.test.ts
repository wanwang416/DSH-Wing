/**
 * P0-3 六个桥命令测试（/stop /new /status /mode /permission /help）
 *
 * 各命令只取用自己需要的 services（可选链安全），测试只构造被测命令用到的部分。
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { stopCommand } from "../../src/commands/stop.js";
import { newCommand } from "../../src/commands/new.js";
import { statusCommand } from "../../src/commands/status.js";
import { modeCommand } from "../../src/commands/mode.js";
import { permissionCommand } from "../../src/commands/permission.js";
import { helpCommand } from "../../src/commands/help.js";
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

const mkCtx = (over: Partial<BridgeCommandContext> = {}): BridgeCommandContext => ({ ...over });

describe("/stop", () => {
  it("有 agent → cancel({kind:user}) + 回「已停止」", async () => {
    const cancel = vi.fn();
    const ctx = mkCtx({
      services: {
        mapper: {
          size: () => 1,
          keys: () => ["oc_1"],
          get: () => ({ status: "running", cancel }),
          disposeAgentFor: vi.fn(),
        },
      },
    });
    const res = await stopCommand.run(ctx, "", msg("/stop"));
    expect(cancel).toHaveBeenCalledWith({ kind: "user" });
    expect(res?.text).toContain("已停止");
  });

  it("无 agent → 回「没有正在进行的任务」，不 cancel", async () => {
    const cancel = vi.fn();
    const ctx = mkCtx({ services: { mapper: { size: () => 0, keys: () => [], get: () => undefined, disposeAgentFor: vi.fn() } } });
    const res = await stopCommand.run(ctx, "", msg("/stop"));
    expect(cancel).not.toHaveBeenCalled();
    expect(res?.text).toContain("没有正在进行的任务");
  });
});

describe("/new", () => {
  it("rotateSession 可用 → 调用(chatId) + 回「已开启全新会话」", async () => {
    const rotateSession = vi.fn(() => Promise.resolve());
    const ctx = mkCtx({ services: { rotateSession } });
    const res = await newCommand.run(ctx, "", msg("/new"));
    expect(rotateSession).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("已开启全新会话");
  });

  it("rotateSession 不可用 → 提示服务不可用", async () => {
    const ctx = mkCtx({ services: {} });
    const res = await newCommand.run(ctx, "", msg("/new"));
    expect(res?.text).toContain("服务不可用");
  });
});

describe("/status", () => {
  it("全字段渲染（连接/待发/待消化/会话数/模型/权限/预设，全中文）", async () => {
    const ctx = mkCtx({
      services: {
        connection: { state: () => "connected" },
        outbox: { pendingCount: () => 3 },
        inboundWal: { pendingCount: () => 2 },
        mapper: { size: () => 1, keys: () => ["oc_1"], get: () => undefined, disposeAgentFor: vi.fn() },
        runtime: { getPermissionMode: () => "workspace-write", setPermissionMode: () => true, getAgentPreset: () => "code" },
        getModel: async () => ({ provider: "deepseek", model: "deepseek-v4" }),
      },
    });
    const res = await statusCommand.run(ctx, "", msg("/status"));
    expect(res?.text).toContain("已连接 ✅");
    expect(res?.text).toContain("待发送：3 条");
    expect(res?.text).toContain("待消化入站：2 条");
    expect(res?.text).toContain("活跃会话：1 个");
    expect(res?.text).toContain("deepseek-v4（deepseek）");
    expect(res?.text).toContain("工作区读写");
    expect(res?.text).toContain("会话预设：code");
  });

  it("无模型 → 显示「未配置」；连接 unknown → 原样显示", async () => {
    const ctx = mkCtx({ services: { getModel: async () => undefined } });
    const res = await statusCommand.run(ctx, "", msg("/status"));
    expect(res?.text).toContain("未配置");
  });
});

describe("/mode", () => {
  it("无参数 → 发权限单选卡（P1-2：当前项置灰 ✓）", async () => {
    const ctx = mkCtx({ services: { runtime: { getPermissionMode: () => "workspace-write", setPermissionMode: () => true, getAgentPreset: () => "code" } } });
    const res = await modeCommand.run(ctx, "", msg("/mode"));
    expect(res?.card).toBeDefined();
    const card = res!.card!;
    expect((card.header as any).title.content).toBe("🔐 切换权限模式");
    const els = (card.body as any).elements as any[];
    const buttons = els.slice(2) as any[];
    expect(buttons).toHaveLength(3);
    expect(buttons[0].behaviors[0].value.op).toBe("mode:read-only");
    // 当前项（workspace-write）→ 置灰 ✓
    expect(buttons[1].text.content).toBe("工作区读写 ✓");
    expect(buttons[1].disabled).toBe(true);
  });

  it("非法参数 → 提示不吞 + 不调用 setPermissionMode", async () => {
    const setPermissionMode = vi.fn(() => true);
    const ctx = mkCtx({ services: { runtime: { getPermissionMode: () => "workspace-write", setPermissionMode, getAgentPreset: () => "code" } } });
    const res = await modeCommand.run(ctx, "super-admin", msg("/mode super-admin"));
    expect(res?.text).toContain("未知模式");
    expect(res?.text).toContain("read-only");
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it("合法参数 → setPermissionMode + 注明只对新消息生效", async () => {
    const setPermissionMode = vi.fn(() => true);
    const ctx = mkCtx({ services: { runtime: { getPermissionMode: () => "workspace-write", setPermissionMode, getAgentPreset: () => "code" } } });
    const res = await modeCommand.run(ctx, "read-only", msg("/mode read-only"));
    expect(setPermissionMode).toHaveBeenCalledWith("read-only");
    expect(res?.text).toContain("已切换为");
    expect(res?.text).toContain("只对后续新消息生效");
  });

  it("setPermissionMode 返回 false → 提示更新失败", async () => {
    const ctx = mkCtx({ services: { runtime: { getPermissionMode: () => "workspace-write", setPermissionMode: () => false, getAgentPreset: () => "code" } } });
    const res = await modeCommand.run(ctx, "read-only", msg("/mode read-only"));
    expect(res?.text).toContain("更新失败");
  });
});

describe("/permission", () => {
  it("发权限单选卡 + 三级说明 + 当前项置灰（P1-2）", async () => {
    const ctx = mkCtx({ services: { runtime: { getPermissionMode: () => "read-only", setPermissionMode: () => true, getAgentPreset: () => "code" } } });
    const res = await permissionCommand.run(ctx, "", msg("/permission"));
    expect(res?.card).toBeDefined();
    const card = res!.card!;
    // 说明含三级 + 当前模式
    const title = (card.body as any).elements[0].content as string;
    expect(title).toContain("只读");
    expect(title).toContain("danger-full-access");
    // 按钮 opPrefix = permission
    const buttons = (card.body as any).elements.slice(2) as any[];
    expect(buttons[0].behaviors[0].value.op).toBe("permission:read-only");
    // 当前项 read-only 置灰 ✓
    expect(buttons[0].text.content).toBe("只读 ✓");
    expect(buttons[0].disabled).toBe(true);
  });
});

describe("/help", () => {
  it("列出已注册命令", async () => {
    const ctx = mkCtx({
      services: {
        listCommands: () => [
          { name: "stop", description: "立即停止当前正在进行的任务" },
          { name: "new", description: "开启一个全新会话（旧会话保留在 DSH 列表）" },
        ],
      },
    });
    const res = await helpCommand.run(ctx, "", msg("/help"));
    expect(res?.text).toContain("/stop");
    expect(res?.text).toContain("/new");
    expect(res?.text).toContain("DSH 原生命令");
  });

  it("无注册命令 → 提示没有可用命令", async () => {
    const ctx = mkCtx({ services: { listCommands: () => [] } });
    const res = await helpCommand.run(ctx, "", msg("/help"));
    expect(res?.text).toContain("没有可用命令");
  });
});
