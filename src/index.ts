/**
 * dsh-wing — DSH 飞书原生插件（M1：最小可用 + 体验先行）
 *
 * 链路：飞书消息 → WS → dispatcher → session mapper → DSH agent
 *      → session 事件（6 种）→ forwarder → experience（流式/插话/工具可见/表情）
 *      → sender/outbox → 飞书回复
 *
 * 铁律：session 前缀 feishu: 隔离（绝不复用 Web GUI 会话）
 *       streaming.enabled 默认 true / permissionMode 默认 workspace-write
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { getConfig, type WingConfig } from "./config/defaults.js";
import { createCredentialStore } from "./host/credentials.js";
import { buildLarkClient, type WingLarkClient } from "./host/client.js";
import { createTransport } from "./host/websocket.js";
import { createStatusStore } from "./host/status.js";
import { createQuotaGovernor } from "./host/quota.js";
import { createConnectionSupervisor } from "./host/supervisor.js";
import { createInboundWal } from "./inbound/wal.js";
import { createMissedCompensation } from "./inbound/compensation.js";
import { createBatching } from "./inbound/batching.js";
import { createGroupPolicy } from "./inbound/group-policy.js";
import { parseInboundMessage, type ParsedMessage } from "./inbound/parser.js";
import { chatTypeOf } from "./inbound/chat-type.js";
import { createDedupeStore } from "./inbound/dedup.js";
import { createDispatcher } from "./inbound/dispatcher.js";
import { createEventHandler } from "./inbound/event-handler.js";
import { sessionKey, createSessionMapper, resetRunNonce, resetGeneration } from "./session/mapper.js";
import { createRouteStore } from "./session/persistence.js";
import { createSerialQueue } from "./session/serial.js";
import { createAgent, resumeAgent, type WingAgentHandle } from "./agent/caller.js";
import { createForwarder } from "./agent/forwarder.js";
import { createUserQuestionBridge, messageIdOfRes } from "./agent/user-questions.js";
import { createExperience } from "./agent/experience.js";
import { createCommandRouter } from "./commands/router.js";
import type { BridgeCommandDef, BridgeCommandContext, DshCommandResult, DshCommandService } from "./commands/types.js";
import { stopCommand } from "./commands/stop.js";
import { newCommand } from "./commands/new.js";
import { statusCommand } from "./commands/status.js";
import { modeCommand } from "./commands/mode.js";
import { permissionCommand } from "./commands/permission.js";
import { modelCommand } from "./commands/model.js";
import { presetCommand } from "./commands/preset.js";
import { helpCommand } from "./commands/help.js";
import { createModelOverrideStore } from "./session/model-overrides.js";
import { createModelRegistry, createModelSync } from "./agent/model.js";
import { listPresets, SHIPPED_PRESETS, type PresetOption } from "./agent/preset.js";
import { createInteractiveRouter } from "./interactive/router.js";
import { createApprovalBridge } from "./interactive/approval.js";
import { classifyIntent, Intent } from "./agent/intent.js";
import { resumeCommand } from "./commands/resume.js";
import { workspaceCommand } from "./commands/workspace.js";
import { steerCommand } from "./commands/steer.js";
import { setupCommand } from "./commands/setup.js";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { SelectorItem } from "./interactive/selector.js";
import { createTurnSupervisor } from "./agent/turn-supervisor.js";
import { createSender } from "./outbound/sender.js";
import { createOutbox } from "./outbound/outbox.js";
import { StreamingCard } from "./outbound/streaming-card.js";
import { createReactionManager } from "./interactive/reaction.js";

export const name = "dsh-wing";

export const inject = ["tools", "commands", "agents", "systemPrompt", "credentials", "userQuestions"];

/** 状态目录：<DSH_HOME>/wing（可用 DSH_WING_HOME 覆盖） */
export function stateDir(): string {
  return process.env.DSH_WING_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "wing");
}

export function apply(ctx: any, rawConfig: unknown): void {
  const raw = (rawConfig ?? {}) as { enabled?: boolean };
  if (raw.enabled === false) return;

  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const cfg: WingConfig = getConfig(ctx, rawConfig);
  // ★ 日志落盘：所有 dsh-wing 日志同时写到 wing/dsh-wing.log，方便不依赖终端窗口排查
  const logFile = join(dir, "dsh-wing.log");
  const fileLog = (level: string, m: string) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${m}\n`);
    } catch {
      // 忽略写文件失败
    }
  };
  const logger = {
    info: (m: string) => { ctx.logger?.info?.(`[dsh-wing] ${m}`); fileLog("info", m); },
    warn: (m: string) => { ctx.logger?.warn?.(`[dsh-wing] ${m}`); fileLog("warn", m); },
    error: (m: string) => { ctx.logger?.error?.(`[dsh-wing] ${m}`); fileLog("error", m); },
  };

  // M0 遗留：加载 marker（证明插件被 DSH 加载；非 DSH 环境忽略）
  try {
    const home = process.env.DSH_HOME ?? homedir();
    writeFileSync(join(home, ".dsh-wing-loaded"), `loaded at ${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // 忽略
  }

  // ---------- 状态存储（★M0 教训：sessions 实时更新，不重蹈死字段） ----------
  const routeStore = createRouteStore(join(dir, "routes.json"));
  const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
  const status = createStatusStore(join(dir, "status.json"));
  // P1-2 per-chat 模型 override（/model 手动切换，重启恢复；与 routes.json 独立）
  const modelOverrides = createModelOverrideStore(join(dir, "model-overrides.json"));

  // ---------- 凭据 + 客户端 ----------
  const credStore = createCredentialStore(ctx);
  let larkClient: WingLarkClient | undefined;
  const getLarkClient = () => larkClient;

  // ---------- 出站（sender + outbox） ----------
  const sender = createSender({ getClient: getLarkClient, logger });
  // ---------- M3 任务 1：ask-user-question 飞书桥（monkey-patch ctx.userQuestions.ask，飞书优先） ----------
  const userQuestionBridge = createUserQuestionBridge({
    sendCard: (chatId, card) => sender.sendCard(chatId, card),
    updateCard: (messageId, cardJson) => sender.updateCard(messageId, cardJson),
    sendText: (chatId, text) => sender.sendText(chatId, text),
    messageIdOf: messageIdOfRes,
    logger,
    // ★ R5.1 根因修复：此前未传 timeoutMs → 内部默认 30s，用户稍晚点击按钮时 pending 已静默过期
    //   （pendingKeys=[] → steer 兜底但 agent 已空闲 → 连续卡片中断，2026-08-28 真机坐实）
    timeoutMs: cfg.turnTimeoutMs,
  });
  const disposeAskPatch = userQuestionBridge.patchAsk(ctx);
  const outbox = createOutbox({
    dir: join(dir, "outbox"),
    deliver: async (env) => {
      try {
        if (env.kind === "text") {
          await sender.sendText(env.chatId, env.payload.text ?? "");
        } else if (env.kind === "card") {
          await sender.sendCard(env.chatId, env.payload.card);
        } else if (env.kind === "reaction" && env.payload.messageId && env.payload.emojiType) {
          await sender.addReaction(env.payload.messageId, env.payload.emojiType);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
    onStatsChange: (stats) => {
      status.refreshCounters({ outboxPending: stats.pending, outboxFailed: stats.failed });
    },
    logger,
  });

  // ---------- 连接监督（M2：probe + 配额熔断 + 自动重连，WS 假死根因解决） ----------
  const quota = createQuotaGovernor(join(dir, "conn-history.jsonl"), { windowMinutes: 60, limit: 12 });
  const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
  const compensation = createMissedCompensation({
    routes: routeStore,
    listMessages: async ({ chatId, startTimeMs, endTimeMs }) => {
      const c = getLarkClient();
      if (!c?.listMessages) return [];
      return (await c.listMessages({ container_id_type: "chat", container_id: chatId, start_time: String(startTimeMs), end_time: String(endTimeMs) })) ?? [];
    },
    reinject: async (msg) => {
      // 补偿消息重入处理管线（文本提取失败则跳过——M2 只补有内容的）
      if (!msg.text) return;
      await dispatcher.handleEvent("im.message.receive_v1", {
        message: { message_id: msg.messageId, chat_id: msg.chatId, chat_type: msg.chatType, message_type: "text", content: JSON.stringify({ text: msg.text }) },
      });
    },
    logger,
  });

  // ---------- 表情 + 轮次监督 ----------
  const reactionManager = createReactionManager({
    addReaction: (messageId, emoji) => sender.addReaction(messageId, emoji),
    enabled: () => cfg.reactions.enabled,
  });
  let mapper: ReturnType<typeof createSessionMapper<WingAgentHandle>> | undefined;
  const turnSupervisor = createTurnSupervisor({
    timeoutMs: cfg.turnTimeoutMs,
    onTimeout(key) {
      // ★ M4 终审风险2：轮次超时 dispose agent 前先 abort pending，避免用户点按钮后 steer 注入失败
      userQuestionBridge.abortByChatId(key, "turn_timeout");
      void mapper?.disposeAgentFor?.(key).catch(() => void 0);
    },
    logger,
  });

  // ---------- 体验契约（StreamingCard 单卡流式/插话/停止/表情） ----------
  const experience = createExperience({
    sendText: (chatId, text) =>
      outbox.enqueue({
        dedupeKey: `${chatId}:text:${text.length}:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text },
      }) as unknown as Promise<void>,
    // ★ StreamingCard 工厂：单卡流式（思考/工具/回答聚合一张卡），降级回退 outbox text
    createStreamCard: (chatId) =>
      new StreamingCard(chatId, {
        sender,
        logger,
        // ★ M3 任务 2：CardKit 流式打字机（两步创建 + PUT 流式）
        cardkit: {
          create: (cid, cardJson) => sender.sendCardKitCard(cid, cardJson),
          stream: (cardId, content, sequence) => sender.streamCardContent(cardId, content, sequence),
        },
        onFallback: (cid, text) =>
          outbox.enqueue({
            dedupeKey: `${cid}:fallback:${text.length}:${Date.now()}`,
            chatId: cid,
            kind: "text",
            payload: { kind: "text", text },
          }) as unknown as Promise<void>,
      }),
    addReaction: (messageId, emoji) =>
      reactionManager.react(messageId, emoji) as unknown as Promise<void>,
    turnSupervisor,
    cfg: () => cfg,
    logger,
    onFollowupDropped: (chatId, label) => {
      // ★ 豆包终审拍板：C2 补发钩子极端情况（会话销毁）→ 提示用户「会话已失效」
      outbox.enqueue({
        dedupeKey: `${sessionKey(chatId)}:followup-dropped:${label}:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text: "⚠️ 会话已失效，你刚才的消息未能送达。发 /new 可开启新会话。" },
      });
    },
  });

  // ---------- P0-3 runtime 可变状态（/mode 只对新消息生效：新建 agent 读 runtime） ----------
  // 拍板：当前运行 agent 权限不变更，避免中途改权限安全漏洞
  const runtime = {
    permissionMode: cfg.permissionMode,
    agentPreset: cfg.agentPreset,
  };
  /** 校验 + 设置权限模式（非法返回 false）；runtime/commandServices/interactiveRouter 共用 */
  const setPermissionMode = (mode: string): boolean => {
    if (mode !== "read-only" && mode !== "workspace-write" && mode !== "danger-full-access") return false;
    runtime.permissionMode = mode;
    return true;
  };

  // ---------- P1-2 模型 registry + preset 缓存 + 单选卡回调路由 ----------
  // 模型：per-chat live 对象（override 优先）；GUI 默认经 10s 轮询刷新
  const modelRegistry = createModelRegistry({ overrides: modelOverrides });
  const modelSync = createModelSync({
    getGuiModel: () => {
      const cur = ctx.get?.("agentDefaultModel")?.currentSelection?.();
      return cur?.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
    },
    onChange: (sel) => modelRegistry.setModelDefault(sel),
    logger,
  });
  // preset 候选（启动加载真实 roster，失败兜底 4 档；命令层/路由读缓存）
  let presetsCache: PresetOption[] = [...SHIPPED_PRESETS];
  void listPresets(ctx, logger)
    .then((ps) => { if (ps.length > 0) presetsCache = ps; })
    .catch(() => void 0);

  /** /preset 换预设完整 rotate（提取独立：interactiveRouter + 命令层复用，对齐 /new rotate 语义） */
  const rotateSession = async (chatId: string): Promise<void> => {
    await mapper?.disposeAgentFor(chatId); // dispose 旧 agent（内部 gen+1，随即归零）
    resetRunNonce(); // mint fresh runNonce（换新家族，不撞旧日志）
    resetGeneration(chatId); // gen 归零（对齐 rotate 语义）
    routeStore.remove(sessionKey(chatId)); // 移除旧路由账目 → 下次 createAgent 全新创建
  };

  // 单选卡回调路由（依赖 runtime/modelRegistry/rotateSession/reply，须在 event-handler 之前创建）
  // ★ 回执 dedupeKey 带 Date.now() 唯一 token——同一张卡点两次不被 durableReply 去重吞（成熟桥接踩坑）
  const interactiveRouter = createInteractiveRouter({
    runtime: {
      getPermissionMode: () => runtime.permissionMode,
      setPermissionMode,
      getAgentPreset: () => runtime.agentPreset,
      setAgentPreset: (id: string) => { runtime.agentPreset = id; },
    },
    modelRegistry,
    rotateSession,
    reply: (chatId, text) =>
      outbox.enqueue({
        dedupeKey: `${sessionKey(chatId)}:sel:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text },
      }),
    presets: () => presetsCache,
    logger,
  });

  // ---------- P1-1 审批卡（danger-full-access 危险操作审批；ALAN 拍板④：仅老板本人可点） ----------
  // approval/request waterfall：记忆命中 → 直接 allowed-once；否则弹四按钮审批卡
  const approvalBridge = createApprovalBridge({
    sendCard: (chatId, card) =>
      outbox.enqueue({
        dedupeKey: `${sessionKey(chatId)}:approval:${Date.now()}`,
        chatId,
        kind: "card",
        payload: { kind: "card", card },
      }),
    sendText: (chatId, text) =>
      outbox.enqueue({
        dedupeKey: `${sessionKey(chatId)}:approval:text:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text },
      }),
    bossOpenId: cfg.bossOpenId,
    timeoutMs: cfg.turnTimeoutMs,
    memoryFile: join(dir, "approval-memory.json"),
    logger,
  });
  // 注册 answerer（cordis waterfall：返回 outcome 认领；非 feishu agent → next() 让后续）
  const disposeApproval = ctx.on("approval/request", (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) =>
    approvalBridge.answer(req, next),
  );

  // ---------- P0-2 命令系统（注册制三级分流，对齐基底成熟桥接命令路由） ----------
  // 注册制：新增桥命令 = 定义 BridgeCommandDef + 注册进 bridgeCommands（P0-3 填 /stop /new 等）
  const bridgeCommands = new Map<string, BridgeCommandDef>();
  // 桥命令可用服务（supervisor 等延迟就绪的对象在注册区赋值；runCommand 调用时已就绪）
  let commandServices: BridgeCommandContext["services"] | undefined;
  // DSH 命令服务薄封装（真实 API：@deepseek-ai/dsh-commands CommandRuntime。
  // execute(agent, line, images, signal)，images 传空数组——当前 SDK 签名，勿沿用既有桥接旧 3 参）
  const dshCommandService: DshCommandService = {
    find(agent, name) {
      try {
        return Boolean(ctx.commands?.find?.(agent, name));
      } catch {
        return false;
      }
    },
    async execute(agent, line) {
      try {
        const out = await ctx.commands?.execute?.(agent, line, [], new AbortController().signal);
        return out?.result as DshCommandResult | undefined;
      } catch (err) {
        return { kind: "error", text: err instanceof Error ? err.message : String(err) };
      }
    },
  };
  const commandRouter = createCommandRouter({
    bridgeCommands,
    dsh: dshCommandService,
    getAgent(chatId) {
      const handle = mapper?.get(chatId);
      return handle ? { raw: (handle as WingAgentHandle).rawAgent } : undefined;
    },
  });

  /** 命令执行 + 收尾（桥命令 / DSH 命令统一走 WAL + 路由 + 回复 + DONE 表情） */
  async function runCommand(
    routed:
      | { kind: "bridge"; command: BridgeCommandDef; rawInput: string }
      | { kind: "dsh"; name: string; rawInput: string; line: string; agent: unknown },
    msg: ParsedMessage,
  ): Promise<void> {
    const cmdName = routed.kind === "bridge" ? routed.command.name : routed.name;
    let reply: string | undefined;
    let replyCard: Record<string, unknown> | undefined;
    let doneReaction = routed.kind === "bridge"; // 桥命令执行成功打 DONE（对齐基底成熟桥接命令路由）
    if (routed.kind === "bridge") {
      const res = await routed.command
        .run({ logger, services: commandServices }, routed.rawInput, msg)
        .catch((err: unknown): { text?: string; card?: Record<string, unknown> } => ({
          text: `⚠️ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`,
        }));
      reply = res?.text;
      replyCard = res?.card;
    } else {
      // DSH 命令格式适配（哈马注意事项 3）：success→原文；error→⚠️ 前缀；无文本→提示已执行
      const res = await dshCommandService.execute(routed.agent, routed.line);
      if (res?.kind === "error") reply = `⚠️ ${res.text}`;
      else if (res?.text) reply = res.text;
      else reply = `命令 /${cmdName} 已执行（无文本输出）`;
    }

    // 收尾（对齐 handleInbound queued 分支的 WAL + 路由账目）
    inboundWal.accept({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      text: msg.text,
      senderOpenId: msg.userId,
    });
    status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
    experience.onInbound(msg.chatId, msg.messageId);
    const key = sessionKey(msg.chatId);
    const route = routeStore.get(key);
    if (route) routeStore.touch(key, msg.messageId);
    else {
      routeStore.upsert({
        sessionKey: key,
        chatId: msg.chatId,
        chatType: msg.chatType,
        sessionId: mapper?.get(msg.chatId)?.sessionId ?? "",
        updatedAt: Date.now(),
      });
    }
    inboundWal.delivered(msg.messageId);
    compensation.noteDelivered(msg.messageId);
    status.refreshCounters({ inboundPending: inboundWal.pendingCount(), sessions: mapper?.size() ?? 0 });

    // 命令回复（持久化 outbox，幂等 per 触发消息；单选卡命令发 card，其余发 text）
    if (reply) {
      outbox.enqueue({
        dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
        chatId: msg.chatId,
        kind: "text",
        payload: { kind: "text", text: reply },
      });
    } else if (replyCard) {
      outbox.enqueue({
        dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
        chatId: msg.chatId,
        kind: "card",
        payload: { kind: "card", card: replyCard },
      });
    }
    // DONE 表情
    if (doneReaction && cfg.reactions.enabled) {
      reactionManager.react(msg.messageId, cfg.reactions.done).catch(() => void 0);
    }
  }

  // ---------- 事件转发（7 种事件 → 体验） ----------
  const forwarder = createForwarder({
    onTurnStart: (chatId) => experience.onTurnStart(chatId),
    onChunk: (chatId, text) => experience.onChunk(chatId, text),
    onThinking: (chatId, text) => experience.onThinking(chatId, text),
    onAssistantMessage: (chatId, text) => void experience.onAssistantMessage(chatId, text),
    onTurnEnd: (chatId, reason) => void experience.onTurnEnd(chatId, reason),
    onToolCall: (chatId, name, input) => void experience.onToolCall(chatId, name, input),
    onToolResult: (chatId, name, error) => void experience.onToolResult(chatId, name, error),
    onContext: (chatId, text) => void experience.onContext(chatId, text),
  });

  // ---------- session 映射（createAgent 工厂：resume 优先，权限应用） ----------
  const makeAgentDeps = () => ({
    ctx,
    workspaceRoot: cfg.workspaceRoot,
    agentPreset: runtime.agentPreset,
    permissionMode: runtime.permissionMode,
    onSessionEvent: (chatId: string, event: Parameters<typeof forwarder.onSessionEvent>[1]) =>
      forwarder.onSessionEvent(chatId, event),
    // P1-2 live 模型对象（/model 手动 override 优先；mutate 即对已存在 agent 生效）
    getModelLive: (chatId: string) => modelRegistry.liveFor(chatId),
    logger,
  });

  mapper = createSessionMapper<WingAgentHandle>({
    async createAgent(chatId: string): Promise<WingAgentHandle> {
      const key = sessionKey(chatId);
      const existing = routeStore.get(key);
      if (existing?.sessionId) {
        try {
          const handle = await resumeAgent(makeAgentDeps(), existing.sessionId);
          routeStore.upsert({ ...existing, sessionId: handle.sessionId, updatedAt: Date.now() });
          return handle;
        } catch (err) {
          logger.warn?.(`resume 失败（${existing.sessionId}），创建新 session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const handle = await createAgent(makeAgentDeps(), chatId);
      routeStore.upsert({
        sessionKey: key,
        chatId,
        chatType: "p2p",
        sessionId: handle.sessionId,
        updatedAt: Date.now(),
      });
      return handle;
    },
    async disposeAgent(handle) {
      await handle.dispose();
    },
  });

  // ---------- 入站分发 ----------
  // ★ 按 DSH 原生 GUI 逻辑：
  // - 任何入站消息立刻进入 handleInbound，不排队，让 handleUserMessage 立刻决策
  // - 只有新建轮次（queued）才进串行队列，保证单 chat 一次只跑一个轮次
  // - steered/stopped 完全不排队，立刻调用 agent.steer/agent.cancel，打断立即生效
  // 这和 DSH GUI 网页端的插话处理完全一致，体验对齐
  const serialQueue = createSerialQueue();
  const dispatcher = createDispatcher({
    dedupe,
    botOpenId: () => transport.botOpenId(),
    logger,
    async handleInbound(msg: ParsedMessage) {
      // ★ P1-3 意图桥：群聊纯寒暄不触发 agent（未明确 @bot → 打 reaction + 消费 WAL，不建 session）
      // p2p 永远不过滤（用户单独找 bot 必须有响应）；@bot 命中 = 用户明确点名，也不过滤
      if (msg.chatType === "group") {
        // 「点名」判定：@ 了任何人（含 @bot）→ 用户明确想引起注意，不过滤（保守防误吞）
        const mentionedBot = msg.mentions.length > 0 || msg.rawText.includes("@");
        const intent = classifyIntent(msg.text);
        // 诊断日志：寒暄消息无论是否放行都留痕（验收遗留——「你好」直通疑点需观察 mentions）
        if (intent === Intent.CHITCHAT) {
          logger.info?.(`群聊寒暄判定 chat=${msg.chatId} intent=${intent} mentionedBot=${mentionedBot} mentions=${msg.mentions.length} raw="${msg.rawText.slice(0, 40)}"`);
        }
        if (intent === Intent.CHITCHAT && !mentionedBot) {
          logger.info?.(`群聊闲聊过滤 chat=${msg.chatId} msg=${msg.messageId} text="${msg.text.slice(0, 30)}"`);
          inboundWal.accept({
            messageId: msg.messageId,
            chatId: msg.chatId,
            chatType: msg.chatType,
            text: msg.text,
            senderOpenId: msg.userId,
          });
          inboundWal.delivered(msg.messageId);
          compensation.noteDelivered(msg.messageId);
          status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
          experience.onInbound(msg.chatId, msg.messageId);
          return;
        }
      }
      // 0) 立即获取/创建 agent（不排队）
      const agent = await mapper!.getOrCreateAgent(msg.chatId);
      // ★ M3 任务 1：先检查是否为待答问题的文本回复（多选/降级/自由文本）→ 消费，不 steer 注入
      if (userQuestionBridge.onTextInbound(msg.chatId, msg.text)) {
        inboundWal.accept({
          messageId: msg.messageId,
          chatId: msg.chatId,
          chatType: msg.chatType,
          text: msg.text,
          senderOpenId: msg.userId,
        });
        inboundWal.delivered(msg.messageId);
        compensation.noteDelivered(msg.messageId);
        status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
        return;
      }
      // 1) 立即构造用户消息（不排队）
      const message = createUserMessage({
        content: [{ type: "text", text: msg.text }],
        source: { kind: "user" },
      });
      // 1.5) P0-2 命令路由（★ 先于四类分类：用户发 /stop 走命令分支，不被分类器误判成 COMMAND steer）
      const routed = await commandRouter.route(msg.text, msg);
      if (routed.kind === "bridge" || routed.kind === "dsh") {
        await runCommand(routed, msg);
        return;
      }
      // 2) 立即调用 handleUserMessage → steer/stop 立即生效（和 DSH GUI 完全一致）
      //    （routed.kind === "inject"：普通消息 / 未知命令 → 原样注入 Agent，不吞命令）
      const action = experience.handleUserMessage(msg.chatId, agent, msg.text, message);
      logger.info?.(`chat=${msg.chatId} 消息 ${msg.messageId} → ${action}`);

      // 3) 分支处理（按 DSH 原生决策）：
      // a) steered/stopped → 立即做完 WAL 和路由，不排队，直接返回 → 打断立即生效
      if (action === "steered" || action === "stopped") {
        inboundWal.accept({
          messageId: msg.messageId,
          chatId: msg.chatId,
          chatType: msg.chatType,
          text: msg.text,
          senderOpenId: msg.userId,
        });
        status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
        experience.onInbound(msg.chatId, msg.messageId);
        const key = sessionKey(msg.chatId);
        const route = routeStore.get(key);
        if (route) routeStore.touch(key, msg.messageId);
        else {
          routeStore.upsert({
            sessionKey: key,
            chatId: msg.chatId,
            chatType: msg.chatType,
            sessionId: agent.sessionId,
            updatedAt: Date.now(),
          });
        }
        inboundWal.delivered(msg.messageId);
        compensation.noteDelivered(msg.messageId);
        status.refreshCounters({
          inboundPending: inboundWal.pendingCount(),
          sessions: mapper?.size() ?? 0,
        });
        return;
      }

      // b) queued → 只有新建轮次才进串行队列，保证单 chat 一次只跑一个轮次（和 DSH 原生一致）
      await serialQueue.enqueue(msg.chatId, async () => {
        inboundWal.accept({
          messageId: msg.messageId,
          chatId: msg.chatId,
          chatType: msg.chatType,
          text: msg.text,
          senderOpenId: msg.userId,
        });
        status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
        experience.onInbound(msg.chatId, msg.messageId);
        const key = sessionKey(msg.chatId);
        const route = routeStore.get(key);
        if (route) routeStore.touch(key, msg.messageId);
        else {
          routeStore.upsert({
            sessionKey: key,
            chatId: msg.chatId,
            chatType: msg.chatType,
            sessionId: agent.sessionId,
            updatedAt: Date.now(),
          });
        }
        inboundWal.delivered(msg.messageId);
        compensation.noteDelivered(msg.messageId);
        status.refreshCounters({
          inboundPending: inboundWal.pendingCount(),
          sessions: mapper?.size() ?? 0,
        });
      });
    },
  });

  // ---------- 群策略 + 合批 ----------
  const groupPolicy = createGroupPolicy({
    policy: () => cfg.groupPolicy,
    keywords: () => (cfg as { groupKeywords?: string[] }).groupKeywords ?? ["lark", "小斯"],
    botOpenId: () => transport.botOpenId(),
    logger,
  });
  const batching = createBatching({
    onFlush: (chatId, items) => {
      // 合批到期：合并文本投给 dispatcher（构造合并事件）
      // ★ M4-R3 任务 4：chat_type 必须来自事件层真实值（BatchItem.chatType 透传）。
      //   oc_ 前缀不能区分群聊/单聊（P2P 会话 chat_id 也是 oc_ 前缀，routes.json 实证），
      //   chatTypeOf 仅作无真值时的兜底。
      const text = batching.merge(items);
      const last = items[items.length - 1];
      void dispatcher.handleEvent("im.message.receive_v1", {
        message: {
          message_id: last.messageId,
          chat_id: chatId,
          chat_type: last.chatType ?? chatTypeOf(chatId),
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    },
  });

  // ---------- 传输层（WS + 单实例锁 + CLOSE frame） ----------
  const transport = createTransport({
    getClient: getLarkClient,
    onMessage: async (data) => {
      // 群策略 + 合批（M2）
      const msg = parseInboundMessage(data as any, transport.botOpenId());
      if (!msg) {
        await dispatcher.handleEvent("im.message.receive_v1", data);
        return;
      }
      if (msg.chatType === "group" && !groupPolicy.shouldProcess(msg)) {
        return; // 群策略忽略
      }
      // ★ 关键修复：p2p 不做合批 → 插话能立即到达 handleInbound → steer 立即生效
      // （合批只为群聊设计：群聊里用户连续发多条短消息应合并；p2p 插话不能被吞）
      // ★ M4-R3 任务 4：携带事件层真实 chatType，合批 flush 透传（不再用前缀猜测）
      // ★ P1-3：@bot 消息跳过合批——点名应即时响应；也避免合批丢 mentions 导致意图桥误过滤
      const botNow = transport.botOpenId();
      const mentionedBot = msg.mentions.includes(botNow ?? "") || (botNow ? msg.rawText.includes(`@${botNow}`) : false);
      if (msg.chatType === "group" && !mentionedBot && batching.add(msg.chatId, { messageId: msg.messageId, text: msg.text, chatType: msg.chatType })) {
        return; // 群聊已合并（窗口到期统一 flush）
      }
      // p2p 或群聊超限：立即处理
      await dispatcher.handleEvent("im.message.receive_v1", data);
    },
    // M4 任务 6 提取重构：5 类事件处理独立模块（bot_added/p2p_entered/card.action/recalled/default）
    onEvent: createEventHandler({ outbox, logger, mapper, userQuestionBridge, experience, interactiveRouter, approvalBridge }),
    lockDir: join(dir, "locks"),
    logger,
  });

  // ---------- 工具注册（M1：feishu_config_get） ----------
  ctx.tools.register(defineTool({
    name: "feishu_config_get",
    description: "Read bridge config (hot-reloadable keys).",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: string) => [{ type: "text", text: value }],
    },
    async execute() {
      return JSON.stringify(cfg, null, 2);
    },
  }));

  // ---------- 系统提示（priority 200） ----------
  try {
    ctx.systemPrompt?.section?.({
      priority: 200,
      section: () => ({
        role: "system",
        content: [
          "你正在通过飞书/Lark 桥接与用户对话。",
          "可用工具: feishu_config_get（读取桥配置）。",
          "回复要简洁；长输出会自动流式呈现给用户。",
          "不要解释技术内部细节（如会话目录命名、进程状态），直接干活给结果。",
        ].join("\n"),
      }),
    });
  } catch {
    // 忽略
  }

  // ---------- 生命周期 ----------
  let lifecycleStarted = false;
  let startBlocker: string | undefined;

  // 连接监督器（M2：probe + 配额熔断 + 自动重连，WS 假死根因解决）
  const supervisor = createConnectionSupervisor({
    transport,
    quota,
    status,
    cfg: {
      // 增大 fail threshold 给飞书足够时间建立第一次连接（根因：飞书新连接分配事件需要几十秒，原阈值 2 次 2 分钟内重连永远收不到）
      probeIntervalMs: 30_000,
      probeTimeoutMs: 8_000,
      probeFailThreshold: 4, // 从 2 → 4 → 4×30s = 2 分钟，给飞书足够时间
      maxReconnectAttempts: 5,
    },
    logger,
    onStateChange: (state) => {
      // 连接恢复 → 丢消息补偿（补拉断连窗口消息）
      if (state === "connected") {
        void compensation.onRecovered().catch(() => void 0);
      }
    },
  });

  // ---------- P0-3 命令注册（所有运行时对象已就绪） ----------
  // 注册制：6 个桥命令只注册进 Map，不改路由核心。commandServices 闭包延迟到此时才可访问 supervisor。
  const admService = ctx.get?.("agentDefaultModel");
  commandServices = {
    mapper: {
      size: () => mapper?.size() ?? 0,
      keys: () => mapper?.keys() ?? [],
      get: (chatId) => {
        const h = mapper?.get(chatId);
        return h ? { status: h.status, cancel: (cause) => h.cancel(cause) } : undefined;
      },
      disposeAgentFor: (chatId) => (mapper?.disposeAgentFor(chatId) ?? Promise.resolve()),
    },
    routeStore: {
      remove: (key) => routeStore.remove(key),
      get: (key) => routeStore.get(key), // P1-3 /resume：查历史 sessionId
    },
    outbox: { pendingCount: () => outbox.pendingCount() },
    inboundWal: { pendingCount: () => inboundWal.pendingCount() },
    connection: { state: () => supervisor.state() },
    runtime: {
      getPermissionMode: () => runtime.permissionMode,
      setPermissionMode, // 提取共用：runtime/interactiveRouter/命令层同一校验
      getAgentPreset: () => runtime.agentPreset,
      setAgentPreset: (id: string) => { runtime.agentPreset = id; },
    },
    getModel: async () => {
      try {
        const cur = admService?.currentSelection?.();
        return cur?.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
      } catch {
        return undefined;
      }
    },
    // /new 完整 rotate：对齐基底成熟桥接实现（fresh runNonce + generation 0 → 无碰撞新 id）
    rotateSession,
    listCommands: () => [...bridgeCommands.values()].map(({ name, description }) => ({ name, description })),
    // P1-2 单选卡命令服务
    sendCard: (chatId, card) =>
      outbox.enqueue({
        dedupeKey: `${sessionKey(chatId)}:card:${Date.now()}`,
        chatId,
        kind: "card",
        payload: { kind: "card", card },
      }),
    listPresets: async () => presetsCache,
    getModelOptions: async () => {
      try {
        const llm = ctx.get?.("llm") as
          | { listProviders?(): Array<{ id?: string; name?: string }>; listModels?(p: string): Promise<Array<{ id: string; name?: string }>> }
          | undefined;
        const providers = llm?.listProviders?.() ?? [];
        const out: SelectorItem[] = [];
        for (const p of providers) {
          const pid = p.id ?? "";
          let models: Array<{ id: string; name?: string }> = [];
          try {
            models = (await llm?.listModels?.(pid)) ?? [];
          } catch {
            // adapter 无模型目录 → 跳过该 provider
          }
          const pLabel = p.name ?? pid;
          for (const m of models) {
            out.push({ id: `${pid}/${m.id}`, label: `${pLabel} · ${m.name ?? m.id}` });
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    modelOverride: {
      has: (chatId) => modelRegistry.hasOverride(chatId),
      set: (chatId, sel) => modelRegistry.setOverride(chatId, sel),
      clear: (chatId) => modelRegistry.clearOverride(chatId),
    },
    // P1-3 第二批命令服务（/resume /workspace /steer）
    resumeSession: async (chatId) => {
      const route = routeStore.get(sessionKey(chatId));
      if (!route?.sessionId) return { resumed: false };
      const handle = await mapper?.getOrCreateAgent(chatId); // 有 route → 自动 resume；已在内存 → 直接复用
      return { resumed: true, sessionId: handle?.sessionId ?? route.sessionId };
    },
    workspace: {
      get: () => cfg.workspaceRoot ?? process.cwd(),
      set: (path) => {
        try {
          if (!existsSync(path) || !statSync(path).isDirectory()) return false;
          cfg.workspaceRoot = path;
          return true;
        } catch {
          return false;
        }
      },
    },
    steer: async (chatId, text) => {
      const handle = mapper?.get(chatId);
      if (!handle) return "no-agent";
      const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
      try {
        if (handle.status === "running") {
          handle.steer(message);
          return "steered";
        }
        handle.followup(message);
        return "queued";
      } catch {
        return "no-agent";
      }
    },
  };
  bridgeCommands.set("stop", stopCommand);
  bridgeCommands.set("new", newCommand);
  bridgeCommands.set("status", statusCommand);
  bridgeCommands.set("mode", modeCommand);
  bridgeCommands.set("permission", permissionCommand);
  bridgeCommands.set("model", modelCommand);
  bridgeCommands.set("preset", presetCommand);
  bridgeCommands.set("help", helpCommand);
  // P1-3 第二批命令
  bridgeCommands.set("resume", resumeCommand);
  bridgeCommands.set("workspace", workspaceCommand);
  bridgeCommands.set("steer", steerCommand);
  bridgeCommands.set("setup", setupCommand);

  const startBridge = async (): Promise<void> => {
    if (lifecycleStarted) return;
    try {
      // 1) 凭据
      const cred = await credStore.resolve(cfg.credentialRef);
      if (!cred?.appId || !cred?.appSecret) {
        startBlocker = `未配置飞书凭据（ref=${cfg.credentialRef}）。请用 DSH 凭据系统写入 WING_LARK_APP。`;
        logger.warn?.(startBlocker);
        return;
      }
      // 2) 客户端
      larkClient = buildLarkClient({
        appId: cred.appId,
        appSecret: cred.appSecret,
        domain: cred.domain,
        logger,
      });
      // 3) outbox 重建 + 启动
      outbox.rebuildFromDisk();
      await outbox.start();
      // 4) 轮次监督
      turnSupervisor.start();
      // 5) 入站 WAL 重放（崩溃补发）
      inboundWal.prune();
      let replayed = 0;
      for (const rec of inboundWal.pendingReplays()) {
        if (!inboundWal.markReplay(rec.messageId)) continue;
        try {
          await dispatcher.handleEvent("im.message.receive_v1", {
            message: {
              message_id: rec.messageId,
              chat_id: rec.chatId,
              chat_type: rec.chatType,
              message_type: "text",
              content: JSON.stringify({ text: rec.text }),
            },
          });
          replayed += 1;
        } catch (err) {
          logger.warn?.(`WAL 重放失败 ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (replayed > 0) logger.info?.(`入站 WAL 重放 ${replayed} 条`);
      status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
      // 6) 连接监督启动（含 WS 连接 + 探活 + 自动重连）
      await supervisor.start();
      // P1-2 模型 GUI 同步（10s 轮询 currentSelection，GUI 切模型 → 桥跟随无 override 会话）
      modelSync.start();
      lifecycleStarted = true;
      startBlocker = undefined;
      logger.info?.("bridge started (M2 + P1-2 model sync)");
    } catch (err) {
      startBlocker = err instanceof Error ? err.message : String(err);
      logger.error?.(`bridge 启动失败: ${startBlocker}`);
    }
  };

  const stopBridge = async (): Promise<void> => {
    if (!lifecycleStarted) return;
    modelSync.stop();
    turnSupervisor.stop();
    await supervisor.stop(); // 内部先 transport.stop（CLOSE frame）
    await outbox.stop();
    // ★ M4 终审风险2：桥停止前 abort 所有 pending，避免残留 Promise 悬挂
    const aborted = userQuestionBridge.abortAll();
    if (aborted > 0) logger.info?.(`桥停止：abort ${aborted} 个待答提问`);
    await mapper?.disposeAll();
    lifecycleStarted = false;
    logger.info?.("bridge stopped");
  };

  ctx.effect(() => {
    void startBridge();
    // 空闲清理：每 10 分钟 dispose 空闲 30 分钟的 agent
    const sweep = setInterval(() => {
      void (async () => {
        const n = (await mapper?.空闲清理(30 * 60_000)) ?? 0;
        if (n > 0) logger.info?.(`清理 ${n} 个空闲 agent`);
        // ★ 实时刷新 sessions（M0 死字段教训）
        status.refreshCounters({ sessions: mapper?.size() ?? 0 });
      })();
    }, 10 * 60_000);
    sweep.unref?.();
    return async () => {
      disposeAskPatch();
      disposeApproval();
      clearInterval(sweep);
      await stopBridge();
    };
  });
}
