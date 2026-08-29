/**
 * P0-2 命令三级分流测试（对齐  成熟桥接命令路由.ts 三级分流，注册制改进）
 *
 * 1. 桥命令（注册 Map）→ kind "bridge"
 * 2. DSH 注册命令（ctx.commands.find 命中）→ kind "dsh"
 * 3. 其余（未知 /xxx、普通消息）→ kind "inject"（原样注入 Agent，不吞命令）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandRouter, stripLeadingMentions, type CommandRouterDeps } from "../../src/commands/router.js";
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

function makeDeps(over: Partial<CommandRouterDeps> = {}): CommandRouterDeps {
  return {
    bridgeCommands: new Map(),
    dsh: {
      find: vi.fn(() => false),
      execute: vi.fn(),
    },
    getAgent: vi.fn(() => undefined),
    ...over,
  };
}

describe("createCommandRouter.isCommand", () => {
  it("/开头 → true；普通消息 → false", () => {
    const deps = makeDeps();
    const router = createCommandRouter(deps);
    expect(router.isCommand("/status")).toBe(true);
    expect(router.isCommand("   /status  ")).toBe(true);
    expect(router.isCommand("你好")).toBe(false);
    expect(router.isCommand("")).toBe(false);
  });
});

describe("createCommandRouter.route · 三级分流", () => {
  it("Tier1：桥命令（注册 Map）→ bridge + 带出 rawInput", async () => {
    const bridgeCommands = new Map([
      ["status", { name: "status", description: "状态", run: vi.fn() }],
      ["stop", { name: "stop", description: "停止", run: vi.fn() }],
    ]);
    const router = createCommandRouter(makeDeps({ bridgeCommands }));
    const r = await router.route("/status 参数甲 乙", msg("/status 参数甲 乙"));
    expect(r.kind).toBe("bridge");
    if (r.kind === "bridge") {
      expect(r.command.name).toBe("status");
      expect(r.rawInput).toBe("参数甲 乙");
    }
  });

  it("Tier1：桥命令大小写不敏感（/STATUS → status）", async () => {
    const bridgeCommands = new Map([["status", { name: "status", description: "x", run: vi.fn() }]]);
    const router = createCommandRouter(makeDeps({ bridgeCommands }));
    const r = await router.route("/STATUS", msg("/STATUS"));
    expect(r.kind).toBe("bridge");
  });

  it("Tier1：多斜杠前缀 /（//status → status）", async () => {
    const bridgeCommands = new Map([["status", { name: "status", description: "x", run: vi.fn() }]]);
    const router = createCommandRouter(makeDeps({ bridgeCommands }));
    const r = await router.route("//status", msg("//status"));
    expect(r.kind).toBe("bridge");
  });

  it("Tier1：@bot 前缀剥离后仍命中桥命令（对齐基底 stripLeadingMentions）", async () => {
    const bridgeCommands = new Map([["status", { name: "status", description: "x", run: vi.fn() }]]);
    const router = createCommandRouter(makeDeps({ bridgeCommands }));
    const r = await router.route("@bot /status", msg("@bot /status"));
    expect(r.kind).toBe("bridge");
  });

  it("Tier2：DSH 注册命令（find 命中）→ dsh + line 构造正确", async () => {
    const dsh = { find: vi.fn(() => true), execute: vi.fn() };
    const agent = { id: "agent-1" };
    const router = createCommandRouter(makeDeps({ dsh, getAgent: () => ({ raw: agent }) }));
    const r = await router.route("/goal 优化性能", msg("/goal 优化性能"));
    expect(r.kind).toBe("dsh");
    if (r.kind === "dsh") {
      expect(r.name).toBe("goal");
      expect(r.rawInput).toBe("优化性能");
      expect(r.line).toBe("/goal 优化性能");
      expect(r.agent).toBe(agent);
      expect(dsh.find).toHaveBeenCalledWith(agent, "goal");
    }
  });

  it("Tier2：DSH 命令无参数 → line 无多余空格", async () => {
    const dsh = { find: vi.fn(() => true), execute: vi.fn() };
    const agent = { id: "agent-1" };
    const router = createCommandRouter(makeDeps({ dsh, getAgent: () => ({ raw: agent }) }));
    const r = await router.route("/compact", msg("/compact"));
    expect(r.kind).toBe("dsh");
    if (r.kind === "dsh") expect(r.line).toBe("/compact");
  });

  it("Tier2：agent 未建（getAgent undefined）→ DSH 命令降级 inject", async () => {
    const dsh = { find: vi.fn(() => true), execute: vi.fn() };
    const router = createCommandRouter(makeDeps({ dsh, getAgent: () => undefined }));
    const r = await router.route("/goal", msg("/goal"));
    expect(r.kind).toBe("inject");
  });

  it("Tier2：find 抛错 → 不当 DSH 命令，降级 inject", async () => {
    const dsh = { find: vi.fn(() => { throw new Error("boom"); }), execute: vi.fn() };
    const router = createCommandRouter(makeDeps({ dsh, getAgent: () => ({ raw: { id: "a" } }) }));
    const r = await router.route("/goal", msg("/goal"));
    expect(r.kind).toBe("inject");
  });

  it("Tier3：未知命令（未注册未注册 DSH）→ inject（不吞命令）", async () => {
    const router = createCommandRouter(makeDeps());
    const r = await router.route("/foobar", msg("/foobar"));
    expect(r.kind).toBe("inject");
  });

  it("Tier3：普通消息（非 / 开头）→ inject", async () => {
    const router = createCommandRouter(makeDeps());
    const r = await router.route("帮我写个脚本", msg("帮我写个脚本"));
    expect(r.kind).toBe("inject");
  });

  it("空串 / 纯斜杠 → inject", async () => {
    const router = createCommandRouter(makeDeps());
    expect((await router.route("", msg(""))).kind).toBe("inject");
    expect((await router.route("/", msg("/"))).kind).toBe("inject");
  });

  it("Tier1 优先于 Tier2：同名桥命令存在时 DSH 同名命令不触发", async () => {
    const bridgeCommands = new Map([["mode", { name: "mode", description: "x", run: vi.fn() }]]);
    const dsh = { find: vi.fn(() => true), execute: vi.fn() };
    const router = createCommandRouter(makeDeps({ bridgeCommands, dsh, getAgent: () => ({ raw: { id: "a" } }) }));
    const r = await router.route("/mode", msg("/mode"));
    expect(r.kind).toBe("bridge");
    expect(dsh.find).not.toHaveBeenCalled();
  });
});

describe("stripLeadingMentions", () => {
  it("剥离开头 <at> 与 @ 提及（对齐基底 命令路由.ts:60）", () => {
    expect(stripLeadingMentions("<at id=ou_1></at> /status")).toBe("/status");
    expect(stripLeadingMentions("@bot /status")).toBe("/status");
    expect(stripLeadingMentions("@bot  @bot2  /help")).toBe("/help");
    expect(stripLeadingMentions("  你好")).toBe("你好");
    expect(stripLeadingMentions("/status 直接命令")).toBe("/status 直接命令");
  });
});
