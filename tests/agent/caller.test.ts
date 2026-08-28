import { describe, expect, it, vi } from "vitest";
import { createAgent, resumeAgent } from "../../src/agent/caller.js";

/** mock agent 结果（agents.create/resume 返回） */
function makeAgentResult() {
  return {
    agent: {
      id: "a1",
      ctx: { on: vi.fn().mockReturnValue(vi.fn()) },
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
      status: "idle",
      whenIdle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

/** mock DSH ctx：workspaceRegistry / agentDefaultModel / agentPresets / agents.create */
function makeCtx() {
  const attachSession = vi.fn().mockResolvedValue(undefined);
  const workspaceCreate = vi.fn().mockResolvedValue({ attachSession });
  // agents.create 会执行 setup（覆盖 installModelSelection / presets.mount 分支）
  const agentsCreate = vi.fn().mockImplementation(async (args: any) => {
    if (typeof args?.setup === "function") await args.setup({ on: vi.fn().mockReturnValue(vi.fn()) });
    return makeAgentResult();
  });
  const ctx = {
    get: (key: string) => {
      if (key === "workspaceRegistry") return { create: workspaceCreate };
      // 无模型选择 → 不触发 installModelSelection（避免依赖真实 DSH 库）
      if (key === "agentDefaultModel") return { currentSelection: () => undefined };
      if (key === "agentPresets") return { mount: vi.fn().mockResolvedValue(undefined) };
      return undefined;
    },
    agents: { create: agentsCreate },
  };
  return { ctx, workspaceCreate, agentsCreate, attachSession };
}

function makeDeps(ctx: any, overrides: Record<string, unknown> = {}) {
  return {
    ctx,
    agentPreset: "default",
    permissionMode: "workspace-write" as const,
    onSessionEvent: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("createAgent workspaceRoot 传递（M4 任务 4b）", () => {
  it("含空格路径完整传递：agents.create.meta.cwd 与 workspace attach cwd 都不被拆分", async () => {
    const { ctx, workspaceCreate, agentsCreate } = makeCtx();
    const root = " 本地目录H"; // 含空格的真实 workspaceRoot（cordis.patch.yml 配置值）
    await createAgent(makeDeps(ctx, { workspaceRoot: root }), "oc_1");

    // 1) session 的 meta.cwd 完整透传（含空格）
    expect(agentsCreate).toHaveBeenCalledTimes(1);
    const meta = agentsCreate.mock.calls[0][0].meta as { cwd: string; agentPreset: string };
    expect(meta.cwd).toBe(root);

    // 2) workspace attach 收到完整 cwd + basename 完整（含空格，"本地目录" 不被拆成两段）
    expect(workspaceCreate).toHaveBeenCalledTimes(1);
    expect(workspaceCreate.mock.calls[0][0]).toBe(root);
    expect(workspaceCreate.mock.calls[0][1]).toBe("本地目录");
  });

  it("未传 workspaceRoot → 回退 process.cwd()", async () => {
    const { ctx, agentsCreate } = makeCtx();
    await createAgent(makeDeps(ctx), "oc_1");
    const meta = agentsCreate.mock.calls[0][0].meta as { cwd: string };
    expect(meta.cwd).toBe(process.cwd());
  });

  it("session 归属 workspace：attachSession 用 createAgent 的 sessionId", async () => {
    const { ctx, attachSession, workspaceCreate } = makeCtx();
    await createAgent(makeDeps(ctx, { workspaceRoot: "D:\\ws" }), "oc_1");
    expect(workspaceCreate).toHaveBeenCalledTimes(1);
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(attachSession.mock.calls[0][0] as string).toMatch(/^feishu:oc_1:/);
  });
});

describe("createAgent 异常路径", () => {
  it("agents.create 未返回 agent → throw", async () => {
    const { ctx } = makeCtx();
    (ctx.agents as any).create = vi.fn().mockResolvedValue({});
    await expect(createAgent(makeDeps(ctx), "oc_1")).rejects.toThrow("未返回 agent");
  });

  it("create 非冲突错误 → 原样抛出", async () => {
    const { ctx } = makeCtx();
    (ctx.agents as any).create = vi.fn().mockRejectedValue(new Error("other"));
    await expect(createAgent(makeDeps(ctx), "oc_1")).rejects.toThrow("other");
  });

  it("workspaceRegistry.create 失败 → 不崩溃（warn 日志）", async () => {
    const { ctx, workspaceCreate } = makeCtx();
    workspaceCreate.mockRejectedValue(new Error("fs"));
    await expect(createAgent(makeDeps(ctx, { workspaceRoot: "D:\\ws" }), "oc_1")).resolves.toBeTruthy();
  });

  it("workspaceRegistry 不可用 → 不崩溃", async () => {
    const ctx2: any = {
      get: () => undefined,
      agents: { create: vi.fn().mockImplementation(makeAgentResult) },
    };
    await expect(createAgent(makeDeps(ctx2), "oc_1")).resolves.toBeTruthy();
  });
});

describe("createAgent session 冲突", () => {
  it("session 已存在 → 自动 resume", async () => {
    const { ctx } = makeCtx();
    const agentResult = makeAgentResult();
    (ctx.agents as any).create = vi.fn().mockRejectedValueOnce(new Error("already exists")).mockResolvedValue(agentResult);
    const resume = vi.fn().mockResolvedValue(agentResult);
    (ctx.agents as any).resume = resume;
    const handle = await createAgent(makeDeps(ctx), "oc_1");
    expect(resume).toHaveBeenCalled();
    expect(handle.sessionId).toMatch(/^feishu:oc_1:/);
  });

  it("冲突且 resume 也失败 → mint fresh 重新 create", async () => {
    const agentResult = makeAgentResult();
    const create = vi.fn().mockRejectedValueOnce(new Error("already has a persisted log")).mockResolvedValue(agentResult);
    const ctx3: any = {
      get: () => undefined,
      agents: { create, resume: vi.fn().mockRejectedValue(new Error("resume down")) },
    };
    const handle = await createAgent(makeDeps(ctx3), "oc_1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(handle.sessionId).toMatch(/^feishu:oc_1:/);
  });
});

describe("resumeAgent（重启恢复）", () => {
  it("resume 指定 sessionId → 含空格 workspaceRoot 完整 attach", async () => {
    const { ctx, workspaceCreate } = makeCtx();
    (ctx.agents as any).resume = vi.fn().mockImplementation(makeAgentResult);
    const handle = await resumeAgent(
      makeDeps(ctx, { workspaceRoot: " 本地目录H" }),
      "feishu:oc_2:abc:0",
    );
    expect((ctx.agents as any).resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: "feishu:oc_2:abc:0" }),
    );
    // attachWorkspace 用 workspaceRoot（含空格完整），basename 不拆分
    expect(workspaceCreate.mock.calls[0][0]).toBe(" 本地目录H");
    expect(workspaceCreate.mock.calls[0][1]).toBe("本地目录");
    expect(handle.sessionId).toBe("feishu:oc_2:abc:0");
  });

  it("未传 workspaceRoot → resume attach 用 process.cwd()", async () => {
    const { ctx, workspaceCreate } = makeCtx();
    (ctx.agents as any).resume = vi.fn().mockImplementation(makeAgentResult);
    await resumeAgent(makeDeps(ctx), "feishu:oc_3:def:0");
    expect(workspaceCreate.mock.calls[0][0]).toBe(process.cwd());
  });

  it("resume 事件回调 → 从 sessionId 反推 chatId 触发 onSessionEvent", async () => {
    const { ctx } = makeCtx();
    let handler: ((s: any, ev: any) => void) | undefined;
    const agent = {
      id: "a1",
      ctx: { on: vi.fn((_s: any, cb: any) => { handler = cb; return vi.fn(); }) },
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
      status: "idle",
      whenIdle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    (ctx.agents as any).resume = vi.fn().mockResolvedValue({ agent, dispose: vi.fn().mockResolvedValue(undefined) });
    const onSessionEvent = vi.fn();
    await resumeAgent(makeDeps(ctx, { workspaceRoot: "D:\\ws", onSessionEvent }), "feishu:oc_2:abc:0");
    handler?.(undefined, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "你好" }] } } });
    expect(onSessionEvent).toHaveBeenCalledWith("oc_2", { type: "assistant/message", text: "你好" });
  });
});

describe("createAgent 其余分支", () => {
  it("agentDefaultModel 有选择 → agents.create 带 agentOptions", async () => {
    const { ctx } = makeCtx();
    (ctx as any).get = (key: string) => {
      if (key === "workspaceRegistry") return { create: vi.fn().mockResolvedValue({ attachSession: vi.fn() }) };
      if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) };
      if (key === "agentPresets") return { mount: vi.fn() };
      return undefined;
    };
    const create = ctx.agents.create as ReturnType<typeof makeCtx>["agentsCreate"];
    await createAgent(makeDeps(ctx), "oc_1");
    expect(create.mock.calls[0][0].agentOptions).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("workspace create 成功但无 attachSession → warn 不崩溃", async () => {
    const { ctx } = makeCtx();
    (ctx as any).get = (key: string) =>
      key === "workspaceRegistry" ? { create: vi.fn().mockResolvedValue({}) } : undefined;
    await expect(createAgent(makeDeps(ctx, { workspaceRoot: "D:\\ws" }), "oc_1")).resolves.toBeTruthy();
  });

  it("handle 方法转发到 agent + dispose 清理", async () => {
    const { ctx } = makeCtx();
    const handle = await createAgent(makeDeps(ctx), "oc_1");
    // mockImplementation 为 async → results[0].value 是 promise，需 await
    const owned = (await (ctx.agents.create.mock.results[0].value as any)) as any;
    const agent = owned.agent;

    handle.followup({ text: "x" });
    expect(agent.followup).toHaveBeenCalledWith({ text: "x" });
    handle.steer({ text: "s" });
    expect(agent.steer).toHaveBeenCalledWith({ text: "s" });
    handle.cancel({ kind: "user" });
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" }, undefined);
    expect(handle.status).toBe("idle");
    await handle.whenIdle();
    expect(agent.whenIdle).toHaveBeenCalled();

    await handle.dispose();
    // dispose = disp(取消订阅) + owned.dispose(顶层释放)
    const disp = (agent.ctx.on as ReturnType<typeof vi.fn>).mock.results[0].value as ReturnType<typeof vi.fn>;
    expect(disp).toHaveBeenCalled();
    expect(owned.dispose).toHaveBeenCalled();
  });

  it("createAgent 事件回调 → onSessionEvent 归一化事件", async () => {
    let handler: ((s: any, ev: any) => void) | undefined;
    const agent = {
      id: "a1",
      ctx: { on: vi.fn((_s: any, cb: any) => { handler = cb; return vi.fn(); }) },
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
      status: "idle",
      whenIdle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const { ctx } = makeCtx();
    (ctx.agents as any).create = vi.fn().mockResolvedValue({ agent, dispose: vi.fn().mockResolvedValue(undefined) });
    const onSessionEvent = vi.fn();
    await createAgent(makeDeps(ctx, { onSessionEvent }), "oc_9");
    handler?.(undefined, { type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "流式" } } });
    expect(onSessionEvent).toHaveBeenCalledWith("oc_9", { type: "assistant/chunk", text: "流式" });
  });

  it("resume handle 方法转发到 agent", async () => {
    const { ctx } = makeCtx();
    (ctx.agents as any).resume = vi.fn().mockImplementation(makeAgentResult);
    const handle = await resumeAgent(makeDeps(ctx, { workspaceRoot: "D:\\ws" }), "feishu:oc_4:g:0");
    const agent = ((ctx.agents as any).resume.mock.results[0].value as any).agent;

    handle.followup({ text: "x" });
    expect(agent.followup).toHaveBeenCalledWith({ text: "x" });
    handle.steer({ text: "s" });
    expect(agent.steer).toHaveBeenCalledWith({ text: "s" });
    expect(handle.status).toBe("idle");
    await handle.whenIdle();
    expect(agent.whenIdle).toHaveBeenCalled();

    await handle.dispose();
    const disp = (agent.ctx.on as ReturnType<typeof vi.fn>).mock.results[0].value as ReturnType<typeof vi.fn>;
    expect(disp).toHaveBeenCalled();
  });
});
