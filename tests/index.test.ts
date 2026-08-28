import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── mock 容器（hoisted 保证 mock 工厂可访问） ──────────────────────────────
const h = vi.hoisted(() => {
  const mkAgent = (chatId: string, sessionId: string) => ({
    agentId: "a_" + chatId,
    sessionId,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    status: "idle",
    whenIdle: () => Promise.resolve(),
    dispose: vi.fn().mockResolvedValue(undefined),
  });
  return {
    transportOpts: null as any,
    transportInstance: null as any,
    effectFn: null as any,
    disposeAsk: vi.fn(),
    clients: [] as any[],
    enqueued: [] as any[],
    // 行为开关（测试逐个设置）
    nextAction: "queued" as string,
    nextTextInbound: false,
    shouldProcess: true,
    credResolve: async () => ({ appId: "a", appSecret: "s", domain: "feishu" }),
    replays: [] as any[],
    replayMarked: true,
    supervisorFail: false,
    wal: {
      accept: vi.fn(),
      delivered: vi.fn(),
      pendingCount: vi.fn(() => 0),
      prune: vi.fn(),
      pendingReplays: vi.fn(() => [] as any[]),
      markReplay: vi.fn(() => true),
    },
    walReplace: (replays: any[], marked = true) => {
      (h.wal.pendingReplays as any).mockReturnValue(replays);
      (h.wal.markReplay as any).mockReturnValue(marked);
    },
    mkAgent,
  };
});

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "DOMAIN_FEISHU", Lark: "DOMAIN_LARK" },
  AppType: { SelfBuild: "APP_SELF" },
  LoggerLevel: { debug: "DEBUG", error: "ERROR" },
  Client: vi.fn(function (this: any, opts: any) {
    const self = {
      opts,
      request: vi.fn(),
      im: { message: { create: vi.fn(), patch: vi.fn(), list: vi.fn() }, messageReaction: { create: vi.fn() } },
    };
    h.clients.push(self);
    return self;
  }),
  EventDispatcher: vi.fn(function () {
    return { register: vi.fn() };
  }),
  WSClient: vi.fn(function () {
    return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), getConnectionStatus: vi.fn().mockReturnValue("connected") };
  }),
  defaultHttpInstance: { defaults: { proxy: false } },
}));

vi.mock("../src/host/websocket.js", () => ({
  createTransport: vi.fn((opts: any) => {
    h.transportOpts = opts;
    h.transportInstance = {
      botOpenId: () => "ou_bot",
      isConnected: () => true,
      wsReady: () => true,
      probe: () => Promise.resolve(true),
      lastEventAt: () => 0,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    return h.transportInstance;
  }),
}));

vi.mock("../src/host/client.js", () => ({
  buildLarkClient: vi.fn((opts: any) => {
    h.clients.push({ opts });
    return {
      opts,
      request: vi.fn(),
      im: { message: { create: vi.fn(), patch: vi.fn(), list: vi.fn() }, messageReaction: { create: vi.fn() } },
      isWsReady: () => true,
      connectionStatus: () => "connected",
      ws: { start: vi.fn(), stop: vi.fn() },
    };
  }),
}));

vi.mock("../src/host/credentials.js", () => ({
  createCredentialStore: vi.fn(() => ({
    resolve: () => h.credResolve(),
    set: vi.fn(),
    unset: vi.fn(),
  })),
}));

vi.mock("../src/host/status.js", () => ({
  createStatusStore: vi.fn(() => ({ setConn: vi.fn(), update: vi.fn(), refreshCounters: vi.fn() })),
}));

vi.mock("../src/host/quota.js", () => ({
  createQuotaGovernor: vi.fn(() => ({
    tripped: vi.fn().mockReturnValue(false),
    remaining: vi.fn().mockReturnValue(5),
    recordConnect: vi.fn(),
    recordFailure: vi.fn(),
    reset: vi.fn(),
    resetAt: vi.fn(),
  })),
}));

vi.mock("../src/host/supervisor.js", () => ({
  createConnectionSupervisor: vi.fn((deps: any) => ({
    start: vi.fn().mockImplementation(async () => {
      if (h.supervisorFail) throw new Error("supervisor start boom");
      deps.onStateChange?.("connected");
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn(),
    state: () => "connected",
    reconnect: vi.fn(),
  })),
}));

vi.mock("../src/inbound/wal.js", () => ({
  createInboundWal: vi.fn(() => h.wal),
}));

vi.mock("../src/inbound/compensation.js", () => ({
  createMissedCompensation: vi.fn(() => ({
    noteDelivered: vi.fn(),
    onRecovered: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/inbound/group-policy.js", () => ({
  createGroupPolicy: vi.fn(() => ({
    shouldProcess: () => h.shouldProcess,
  })),
}));

vi.mock("../src/agent/caller.js", () => ({
  createAgent: vi.fn(async (_deps: any, chatId: string) => h.mkAgent(chatId, `feishu:${chatId}:new:0`)),
  resumeAgent: vi.fn(async (_deps: any, sessionId: string) => h.mkAgent("resumed", sessionId)),
}));

vi.mock("../src/agent/forwarder.js", () => ({
  createForwarder: vi.fn(() => ({
    onSessionEvent: vi.fn(),
    onTurnStart: vi.fn(),
    onChunk: vi.fn(),
    onThinking: vi.fn(),
    onAssistantMessage: vi.fn(),
    onTurnEnd: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onContext: vi.fn(),
  })),
}));

vi.mock("../src/agent/experience.js", () => ({
  createExperience: vi.fn(() => ({
    handleUserMessage: vi.fn(() => h.nextAction),
    onInbound: vi.fn(),
    onTurnStart: vi.fn(),
    onChunk: vi.fn(),
    onThinking: vi.fn(),
    onAssistantMessage: vi.fn(),
    onTurnEnd: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onContext: vi.fn(),
  })),
}));

vi.mock("../src/agent/turn-supervisor.js", () => ({
  createTurnSupervisor: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), arm: vi.fn(), disarm: vi.fn() })),
}));

vi.mock("../src/agent/user-questions.js", () => ({
  createUserQuestionBridge: vi.fn(() => ({
    onTextInbound: vi.fn(() => h.nextTextInbound),
    onCardAction: vi.fn(() => false),
    patchAsk: vi.fn(() => h.disposeAsk),
  })),
  messageIdOfRes: vi.fn(),
}));

vi.mock("../src/outbound/sender.js", () => ({
  createSender: vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    addReaction: vi.fn(),
    sendCardKitCard: vi.fn(),
    streamCardContent: vi.fn(),
  })),
}));

vi.mock("../src/outbound/outbox.js", () => ({
  createOutbox: vi.fn(() => ({
    enqueue: vi.fn((env: any) => { h.enqueued.push(env); return Promise.resolve(); }),
    rebuildFromDisk: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/outbound/streaming-card.js", () => ({
  StreamingCard: class {
    constructor(_chatId: string, _opts: unknown) {}
  },
}));

vi.mock("../src/interactive/reaction.js", () => ({
  createReactionManager: vi.fn(() => ({ react: vi.fn().mockResolvedValue(undefined) })),
}));

import { apply, stateDir, name, inject } from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tools: { register: vi.fn() },
    systemPrompt: { section: vi.fn() },
    effect: vi.fn((fn: () => unknown) => { h.effectFn = fn; return vi.fn(); }),
    credentials: { resolve: vi.fn().mockResolvedValue(undefined) },
    userQuestions: { ask: vi.fn() },
    ...overrides,
  };
}

let dir: string;
let oldHome: string | undefined;
let oldWingHome: string | undefined;

function p2pMsg(id: string, text: string, chatId = "ou_1") {
  return {
    message: {
      message_id: id,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: "ou_9" } },
  };
}

function groupMsg(id: string, text: string, chatId = "oc_1") {
  return {
    message: {
      message_id: id,
      chat_id: chatId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: "ou_9" } },
  };
}

async function startBridge(ctx: any): Promise<() => Promise<void>> {
  apply(ctx, {});
  const cleanup = h.effectFn() as unknown as () => Promise<void>;
  return cleanup;
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "wing-index-"));
  oldHome = process.env.DSH_HOME;
  oldWingHome = process.env.DSH_WING_HOME;
  process.env.DSH_WING_HOME = dir;
  process.env.DSH_HOME = dir;
  // 重置行为开关
  h.nextAction = "queued";
  h.nextTextInbound = false;
  h.shouldProcess = true;
  h.credResolve = async () => ({ appId: "a", appSecret: "s", domain: "feishu" });
  h.replays = [];
  h.replayMarked = true;
  h.supervisorFail = false;
  h.enqueued.length = 0;
  h.clients.length = 0;
  // 重置 wal mock 并默认空重放
  for (const k of ["accept", "delivered", "pendingCount", "prune", "pendingReplays", "markReplay"]) {
    (h.wal as any)[k].mockReset();
  }
  h.wal.pendingCount.mockReturnValue(0);
  h.wal.pendingReplays.mockReturnValue([]);
  h.wal.markReplay.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  if (oldWingHome === undefined) delete process.env.DSH_WING_HOME;
  else process.env.DSH_WING_HOME = oldWingHome;
  if (oldHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("index.ts apply 集成（M4 覆盖重构）", () => {
  it("导出契约：name/inject/stateDir", () => {
    expect(name).toBe("dsh-wing");
    expect(inject).toEqual(expect.arrayContaining(["tools", "commands", "agents", "systemPrompt", "credentials", "userQuestions"]));
    // DSH_WING_HOME 已设 → stateDir() 直接返回它（不拼 wing）
    expect(stateDir()).toBe(dir);
  });

  it("enabled=false → apply 直接返回，不注册工具不挂 effect", () => {
    const ctx = makeCtx();
    apply(ctx, { enabled: false });
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.effect).not.toHaveBeenCalled();
  });

  it("apply：创建状态目录 + marker + 工具注册 + 系统提示 + 日志落盘", () => {
    const ctx = makeCtx();
    apply(ctx, {});
    // 状态目录 + marker
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".dsh-wing-loaded"))).toBe(true);
    // 工具注册（feishu_config_get）
    expect(ctx.tools.register).toHaveBeenCalledTimes(1);
    const tool = (ctx.tools.register as any).mock.calls[0][0];
    expect(tool.name).toBe("feishu_config_get");
    // 系统提示
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ priority: 200 }));
    // 日志落盘文件会在 logger 调用后创建（此处验证 logger 接通）
    expect(ctx.logger.info).toBeDefined();
  });

  it("startBridge：无凭据 → 阻塞并 warn，不启动客户端", async () => {
    h.credResolve = async () => undefined;
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("未配置飞书凭据")));
    expect((ctx as any).logger.warn.mock.calls[0][0]).toContain("WING_LARK_APP");
  });

  it("startBridge：完整启动 → 客户端/outbox/turnSupervisor/supervisor 全部启动 + 日志", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    // 客户端构建
    expect(h.clients.length).toBe(1);
    expect(h.clients[0].opts).toEqual(expect.objectContaining({ appId: "a", appSecret: "s", domain: "feishu" }));
    // 文件日志落盘
    expect(existsSync(join(dir, "dsh-wing.log"))).toBe(true);
  });

  it("startBridge：WAL 重放（pendingReplays）→ 重入管线", async () => {
    h.walReplace([{ messageId: "om_w1", chatId: "ou_1", chatType: "p2p", text: "重放文本" }]);
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("入站 WAL 重放 1 条")));
  });

  it("startBridge：WAL 重放跳过（markReplay false）→ 不计数", async () => {
    h.walReplace([{ messageId: "om_w2", chatId: "ou_1", chatType: "p2p", text: "x" }], false);
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
  });

  it("startBridge：supervisor.start 抛错 → 启动失败日志", async () => {
    h.supervisorFail = true;
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining("bridge 启动失败")));
  });

  it("startBridge：WAL 重放时 dispatcher 抛错 → warn 不崩", async () => {
    h.walReplace([{ messageId: "om_w3", chatId: "oc_1", chatType: "group", text: "x" }]);
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
  });

  it("onMessage：群聊被群策略忽略 → 不进入处理管线", async () => {
    h.shouldProcess = false;
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await h.transportOpts.onMessage(groupMsg("om_g1", "群消息"));
    await vi.waitFor(() => expect(h.wal.accept).not.toHaveBeenCalled());
  });

  it("onMessage：p2p 消息 → dispatcher → handleInbound（queued 分支串行队列）", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await h.transportOpts.onMessage(p2pMsg("om_p1", "你好"));
    // 串行队列 flush 后 WAL accept + queued 日志
    await vi.waitFor(() => expect(h.wal.accept).toHaveBeenCalled());
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("→ queued"));
  });

  it("onMessage：p2p 消息被 userQuestionBridge 消费 → 不创建 agent", async () => {
    h.nextTextInbound = true;
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await h.transportOpts.onMessage(p2pMsg("om_p2", "选A"));
    // 消费路径：WAL accept + delivered，不创建 agent（无 queued 日志）
    await vi.waitFor(() => expect(h.wal.accept).toHaveBeenCalled());
    expect(h.wal.delivered).toHaveBeenCalled();
    expect(ctx.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("→ queued"));
  });

  it("onMessage：群聊合批 → 窗口到期 flush 合并事件重入管线", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await h.transportOpts.onMessage(groupMsg("om_b1", "群1", "oc_1"));
    await h.transportOpts.onMessage(groupMsg("om_b2", "群2", "oc_1"));
    // 合批窗口 600ms 到期 → onFlush 闭包 → dispatcher 重入 → handleInbound → WAL accept
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(h.wal.accept).toHaveBeenCalled());
  });

  it("onMessage：P2P 会话（oc_ 前缀 chatId）→ chat_type 用事件真值 p2p（M4-R3 任务 4，不误判 group）", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    // ALAN P2P 会话实证：chatId=oc_1310… 但事件 chat_type=p2p
    await h.transportOpts.onMessage(p2pMsg("om_p2p1", "你好", "oc_1310ac85febf004d34aa554d341b3d8a"));
    await vi.waitFor(() => expect(h.wal.accept).toHaveBeenCalled());
    const accepted = h.wal.accept.mock.calls.at(-1)![0];
    expect(accepted.chatType).toBe("p2p");
  });

  it("onMessage：群聊合批 flush → chat_type 透传事件真值 group（不靠前缀猜测）", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await h.transportOpts.onMessage(groupMsg("om_g1", "群1", "oc_1"));
    await h.transportOpts.onMessage(groupMsg("om_g2", "群2", "oc_1"));
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(h.wal.accept).toHaveBeenCalled());
    const accepted = h.wal.accept.mock.calls.at(-1)![0];
    expect(accepted.chatType).toBe("group");
  });

  it("onEvent：转发到 createEventHandler（接线验证）", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    h.transportOpts.onEvent("im.message.reaction.created_v1", { a: 1 });
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("事件 im.message.reaction.created_v1 收到")));
  });

  it("cleanup：disposeAsk + stopBridge（supervisor/outbox/mapper disposeAll）+ 日志", async () => {
    const ctx = makeCtx();
    const cleanup = await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await cleanup();
    expect(h.disposeAsk).toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge stopped"));
  });

  it("stopBridge 幂等：未启动时 cleanup 不抛错", async () => {
    const ctx = makeCtx();
    const cleanup = await startBridge(ctx);
    await cleanup();
    await cleanup();
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge stopped"));
  });

  it("sweep：空闲清理每 10 分钟触发 → refreshCounters", async () => {
    const ctx = makeCtx();
    await startBridge(ctx);
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge started")));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
    // sweep 里 mapper.空闲清理(30min) → 0 agent → refreshCounters sessions
  });
});
