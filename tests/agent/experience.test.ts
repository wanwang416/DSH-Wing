import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperience } from "../../src/agent/experience.js";
import type { WingConfig } from "../../src/config/defaults.js";

/** StreamingCard 实例：所有方法 vi.fn 返回已 resolved promise */
function makeCard() {
  return {
    addThinking: vi.fn(() => Promise.resolve()),
    addText: vi.fn(() => Promise.resolve()),
    addTool: vi.fn(() => Promise.resolve()),
    setToolResult: vi.fn(() => Promise.resolve()),
    addContext: vi.fn(() => Promise.resolve()),
    finalize: vi.fn(() => Promise.resolve()),
  };
}

function baseCfg(over: Partial<WingConfig> = {}): WingConfig {
  return {
    credentialRef: "WING_LARK_APP",
    chatTypeFromChatId: true,
    streaming: { enabled: true, flushMs: 600 },
    permissionMode: "workspace-write",
    groupPolicy: "mention",
    reactions: { enabled: true, pool: ["👍"], done: "✅", failed: "❌" },
    turnTimeoutMs: 600_000,
    agentPreset: "code",
    interruptClassifierEnabled: true,
    ...over,
  } as WingConfig;
}

interface Harness {
  deps: ReturnType<typeof makeDeps>;
  ex: ReturnType<typeof createExperience>;
  card: ReturnType<typeof makeCard>;
}

function makeDeps() {
  const sendText = vi.fn(() => Promise.resolve());
  const createStreamCard = vi.fn();
  const addReaction = vi.fn(() => Promise.resolve());
  const turnSupervisor = { arm: vi.fn(), disarm: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onFollowupDropped = vi.fn();
  let cfg = baseCfg();
  return {
    sendText,
    createStreamCard,
    addReaction,
    turnSupervisor,
    logger,
    onFollowupDropped,
    cfg: () => cfg,
    setCfg(c: WingConfig) {
      cfg = c;
    },
  };
}

function setup(overCfg?: Partial<WingConfig>): Harness {
  const deps = makeDeps();
  if (overCfg) deps.setCfg(baseCfg(overCfg));
  const ex = createExperience(deps as any);
  const card = makeCard();
  deps.createStreamCard.mockReturnValue(card);
  return { deps, ex, card };
}

describe("experience.onInbound", () => {
  it("reactions 开启 → addReaction 随机表情", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const { deps, ex } = setup();
    ex.onInbound("oc_1", "om_100");
    expect(deps.addReaction).toHaveBeenCalledWith("om_100", "👍");
    vi.restoreAllMocks();
  });
  it("reactions 关闭 → 不 addReaction", () => {
    const { deps, ex } = setup({ reactions: { enabled: false, pool: ["👍"], done: "✅", failed: "❌" } });
    ex.onInbound("oc_1", "om_100");
    expect(deps.addReaction).not.toHaveBeenCalled();
  });
});

describe("experience.onTurnStart / onChunk / onThinking", () => {
  it("onTurnStart → 创建卡片 + arm + addThinking", () => {
    const { deps, ex, card } = setup();
    ex.onTurnStart("oc_1");
    expect(deps.createStreamCard).toHaveBeenCalledWith("oc_1");
    expect(deps.turnSupervisor.arm).toHaveBeenCalledWith("oc_1");
    expect(card.addThinking).toHaveBeenCalledWith("💭 思考中…");
  });
  it("onChunk → hasOutput + addText 流式", () => {
    const { ex, card } = setup();
    ex.onTurnStart("oc_1");
    ex.onChunk("oc_1", "你好");
    expect(card.addText).toHaveBeenCalledWith("你好");
    // hasOutput 置位 → 后续 turn/end 不警告
    expect(ex).toBeTruthy();
  });
  it("onThinking → addThinking 累积", () => {
    const { ex, card } = setup();
    ex.onTurnStart("oc_1");
    ex.onThinking("oc_1", "先分析");
    expect(card.addThinking).toHaveBeenLastCalledWith("先分析");
  });
  it("无卡片时 chunk/thinking 静默（?. 安全）", () => {
    const { deps, ex } = setup();
    ex.onChunk("oc_2", "x");
    ex.onThinking("oc_2", "y");
    expect(deps.sendText).not.toHaveBeenCalled();
  });
});

describe("experience.onAssistantMessage", () => {
  it("卡片存在 → finalize + disarm + done 表情", async () => {
    const { deps, ex, card } = setup();
    ex.onTurnStart("oc_1");
    ex.onInbound("oc_1", "om_9");
    await ex.onAssistantMessage("oc_1", "最终答案");
    expect(card.finalize).toHaveBeenCalledWith("最终答案");
    expect(deps.turnSupervisor.disarm).toHaveBeenCalledWith("oc_1");
    expect(deps.addReaction).toHaveBeenCalledWith("om_9", "✅");
    expect(deps.sendText).not.toHaveBeenCalled();
  });
  it("卡片不可用 + 有效文本 → sendText 降级单条", async () => {
    const { deps, ex } = setup();
    await ex.onAssistantMessage("oc_1", "兜底完整回答");
    expect(deps.sendText).toHaveBeenCalledWith("oc_1", "兜底完整回答");
    expect(deps.turnSupervisor.disarm).toHaveBeenCalledWith("oc_1");
  });
  it("卡片不可用 + 空/空白/No response → 不 sendText", async () => {
    const { deps, ex } = setup();
    await ex.onAssistantMessage("oc_1", "");
    await ex.onAssistantMessage("oc_1", "   ");
    await ex.onAssistantMessage("oc_1", "No response.");
    expect(deps.sendText).not.toHaveBeenCalled();
  });
  it("sendText 抛错 → logger.warn", async () => {
    const { deps, ex } = setup();
    deps.sendText.mockRejectedValueOnce(new Error("chat send fail"));
    await ex.onAssistantMessage("oc_1", "会失败");
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("最终回复发送失败"));
  });
  it("reactions 关闭 → 不发 done 表情", async () => {
    const { deps, ex } = setup({ reactions: { enabled: false, pool: ["👍"], done: "✅", failed: "❌" } });
    ex.onInbound("oc_1", "om_9");
    await ex.onAssistantMessage("oc_1", "ok");
    expect(deps.addReaction).not.toHaveBeenCalled();
  });
});

describe("experience.onToolCall / onToolResult / onContext", () => {
  it("onToolCall → addTool；onToolResult → setToolResult；onContext → addContext", async () => {
    const { ex, card } = setup();
    ex.onTurnStart("oc_1");
    await ex.onToolCall("oc_1", "bash", '{"cmd":"ls"}');
    await ex.onToolResult("oc_1", "bash", undefined);
    await ex.onContext("oc_1", "上下文注入");
    expect(card.addTool).toHaveBeenCalledWith("bash", '{"cmd":"ls"}');
    expect(card.setToolResult).toHaveBeenCalledWith("bash", undefined);
    expect(card.addContext).toHaveBeenCalledWith("上下文注入");
  });
});

describe("experience.onTurnEnd", () => {
  it("无输出 + reason 非 completed → sendText 警告", async () => {
    const { deps, ex } = setup();
    await ex.onTurnEnd("oc_1", "error");
    expect(deps.sendText).toHaveBeenCalledWith("oc_1", "⚠️ 本轮没有产出回复");
  });
  it("有输出 → 不警告", async () => {
    const { deps, ex } = setup();
    ex.onTurnStart("oc_1");
    ex.onChunk("oc_1", "有输出");
    await ex.onTurnEnd("oc_1", "error");
    expect(deps.sendText).not.toHaveBeenCalled();
  });
  it("completed 原因 → 不警告", async () => {
    const { deps, ex } = setup();
    await ex.onTurnEnd("oc_1", "completed");
    expect(deps.sendText).not.toHaveBeenCalled();
  });
  it("error/aborted/max-tokens → failed 表情", async () => {
    const { deps, ex } = setup();
    ex.onInbound("oc_1", "om_5");
    await ex.onTurnEnd("oc_1", "error");
    await ex.onTurnEnd("oc_1", "aborted");
    await ex.onTurnEnd("oc_1", "max-tokens");
    // onInbound 已触发一次随机表情，只数 failed 表情
    const failed = deps.addReaction.mock.calls.filter((c) => c[1] === "❌");
    expect(failed).toHaveLength(3);
    expect(deps.addReaction).toHaveBeenCalledWith("om_5", "❌");
  });
  it("sendText 警告抛错 → 静默吞掉", async () => {
    const { deps, ex } = setup();
    deps.sendText.mockRejectedValueOnce(new Error("x"));
    await expect(ex.onTurnEnd("oc_1", "error")).resolves.toBeUndefined();
  });
});

describe("experience.handleUserMessage", () => {
  const mkAgent = (status: string) => ({
    status,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
  });
  it("停止词 → cancel + stopped", () => {
    const { ex } = setup();
    for (const w of ["停", "停止", "stop", "/stop", "停下来", "别写了", "算了"]) {
      const agent = mkAgent("running");
      expect(ex.handleUserMessage("oc_1", agent, w, {})).toBe("stopped");
      expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    }
  });
  it("大小写不敏感（STOP）→ stopped", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    expect(ex.handleUserMessage("oc_1", agent, "STOP", {})).toBe("stopped");
  });
  it("running → steer + steered", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "继续写", msg)).toBe("steered");
    expect(agent.steer).toHaveBeenCalledWith(msg);
    expect(agent.followup).not.toHaveBeenCalled();
  });
  it("running 但 steer 抛错 → catch 后仍 steered", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    agent.steer.mockImplementation(() => {
      throw new Error("steer boom");
    });
    expect(ex.handleUserMessage("oc_1", agent, "插话", {})).toBe("steered");
  });
  it("idle → followup + queued", () => {
    const { ex } = setup();
    const agent = mkAgent("idle");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "新的问题", msg)).toBe("queued");
    expect(agent.followup).toHaveBeenCalledWith(msg);
  });
});

describe("experience.handleUserMessage · V4 四类分类（interruptClassifierEnabled=true）", () => {
  const mkAgent = (status: string) => ({
    status,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(() => Promise.resolve()),
  });

  it("QUESTION running → whenIdle 后补发 followup + queued（★C2 不打断，忙完自动答）", async () => {
    const { ex } = setup();
    let resolveIdle!: () => void;
    const agent = mkAgent("running");
    agent.whenIdle = vi.fn(() => new Promise<void>((r) => { resolveIdle = r; }));
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "为什么这样设计", msg)).toBe("queued");
    expect(agent.followup).not.toHaveBeenCalled(); // 未 idle 前不补发（防卡 inbox，对齐基底成熟桥接实现）
    expect(agent.steer).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    resolveIdle(); // driver 收敛到 idle
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledWith(msg));
  });

  it("QUESTION idle → followup 直接 + queued（idle 无需补发）", () => {
    const { ex } = setup();
    const agent = mkAgent("idle");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "怎么做这道题", msg)).toBe("queued");
    expect(agent.followup).toHaveBeenCalledWith(msg);
  });

  it("CONFIRM running → whenIdle 后补发 followup + queued（不打断主任务）", async () => {
    const { ex } = setup();
    let resolveIdle!: () => void;
    const agent = mkAgent("running");
    agent.whenIdle = vi.fn(() => new Promise<void>((r) => { resolveIdle = r; }));
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "你确定", msg)).toBe("queued");
    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.steer).not.toHaveBeenCalled();
    resolveIdle();
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledWith(msg));
  });

  it("ORDINARY 纯确认词（好的）running → 仅回执：不 followup 不 steer + queued", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    expect(ex.handleUserMessage("oc_1", agent, "好的", {})).toBe("queued");
    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.steer).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it("ORDINARY 推进词（继续）running → whenIdle 后补发 followup + queued（豆包细分：必须注入）", async () => {
    const { ex } = setup();
    let resolveIdle!: () => void;
    const agent = mkAgent("running");
    agent.whenIdle = vi.fn(() => new Promise<void>((r) => { resolveIdle = r; }));
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "继续", msg)).toBe("queued");
    expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.steer).not.toHaveBeenCalled();
    resolveIdle();
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledWith(msg));
  });

  it("C2：QUESTION running 且 whenIdle reject（agent 销毁）→ 丢弃不重投 + onFollowupDropped 提示（豆包终审拍板）", async () => {
    const { deps, ex } = setup();
    const agent = mkAgent("running");
    agent.whenIdle = vi.fn(() => Promise.reject(new Error("agent disposed")));
    expect(ex.handleUserMessage("oc_1", agent, "为什么", {})).toBe("queued");
    // 等微任务排空后确认不补发
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.followup).not.toHaveBeenCalled();
    expect(deps.onFollowupDropped).toHaveBeenCalledWith("oc_1", expect.stringContaining("question"));
  });

  it("COMMAND 停止词 running → cancel + stopped（不 followup）", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    expect(ex.handleUserMessage("oc_1", agent, "停", {})).toBe("stopped");
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    expect(agent.followup).not.toHaveBeenCalled();
  });

  it("COMMAND 改道词（换个话题）running → cancel + followup + stopped", () => {
    const { ex } = setup();
    const agent = mkAgent("running");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "换个话题", msg)).toBe("stopped");
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    expect(agent.followup).toHaveBeenCalledWith(msg);
  });

  it("null（普通对话）idle → followup + queued", () => {
    const { ex } = setup();
    const agent = mkAgent("idle");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "给我讲个笑话", msg)).toBe("queued");
    expect(agent.followup).toHaveBeenCalledWith(msg);
  });
});

describe("experience · C1 steer 排障日志可配置化（默认关闭）", () => {
  const mkAgent = (status: string) => ({
    status,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(() => Promise.resolve()),
  });
  it("配置 steerDiagLogPath → 触发分支写日志；未配置 → 不写（哈马收尾项：原写死固定路径）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-diag-"));
    const logPath = join(dir, "steer-diag.log");
    // 配置路径 → 写日志
    const { ex } = setup({ steerDiagLogPath: logPath });
    ex.handleUserMessage("oc_1", mkAgent("running"), "停", {});
    expect(readFileSync(logPath, "utf8")).toContain("[steer-diag]");
    // 未配置（默认）→ 不写任何文件
    const logPath2 = join(dir, "steer-diag2.log");
    const { ex: ex2 } = setup(); // 不带 overCfg → cfg 无 steerDiagLogPath（默认关闭）
    ex2.handleUserMessage("oc_1", mkAgent("running"), "停", {});
    expect(existsSync(logPath2)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("experience.handleUserMessage · V4 关（interruptClassifierEnabled=false 回退旧逻辑）", () => {
  const mkAgent = (status: string) => ({
    status,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
  });

  it("推进词「继续」running → steer（回退旧逻辑，不再走分类）", () => {
    const { ex } = setup({ interruptClassifierEnabled: false });
    const agent = mkAgent("running");
    const msg = { type: "user" };
    expect(ex.handleUserMessage("oc_1", agent, "继续", msg)).toBe("steered");
    expect(agent.steer).toHaveBeenCalledWith(msg);
  });

  it("纯确认词「好的」running → steer（旧逻辑把一切非停止词当插话）", () => {
    const { ex } = setup({ interruptClassifierEnabled: false });
    const agent = mkAgent("running");
    expect(ex.handleUserMessage("oc_1", agent, "好的", {})).toBe("steered");
    expect(agent.steer).toHaveBeenCalled();
  });

  it("停止词「停」running → cancel + stopped", () => {
    const { ex } = setup({ interruptClassifierEnabled: false });
    const agent = mkAgent("running");
    expect(ex.handleUserMessage("oc_1", agent, "停", {})).toBe("stopped");
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
  });
});
