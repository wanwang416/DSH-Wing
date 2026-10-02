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

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { appendRotatingLine } from "./log/rotation.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { getConfig, type WingConfig, type PermissionMode } from "./config/defaults.js";
import { createCredentialStore } from "./host/credentials.js";
import { buildLarkClient, type WingLarkClient } from "./host/client.js";
import { createTransport } from "./host/websocket.js";
import { createWecomClient, type WecomClient } from "./host/wecom-client.js";
import { createStatusStore } from "./host/status.js";
import { createQuotaGovernor } from "./host/quota.js";
import { createConnectionSupervisor } from "./host/supervisor.js";
import { createInboundWal } from "./inbound/wal.js";
import { createMissedCompensation } from "./inbound/compensation.js";
import { createBatching } from "./inbound/batching.js";
import { createGroupPolicy } from "./inbound/group-policy.js";
import { parseInboundMessage, type ParsedMessage } from "./inbound/parser.js";
import { parseWecomInbound, isWecomChatId, consumeWecomGroupDiag } from "./inbound/wecom-parser.js";
import { chatTypeOf } from "./inbound/chat-type.js";
import { createDedupeStore } from "./inbound/dedup.js";
import { createDispatcher } from "./inbound/dispatcher.js";
import { createEventHandler } from "./inbound/event-handler.js";
import { sessionKey, SESSION_PREFIX, WECOM_SESSION_PREFIX, createSessionMapper, resetRunNonce, resetGeneration, rememberPlatform, chatPlatform } from "./session/mapper.js";
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
import { createPermissionOverrideStore, checkPermissionChange } from "./session/permission-overrides.js";
import { createModelRegistry, createModelSync } from "./agent/model.js";
import { listPresets, SHIPPED_PRESETS, type PresetOption } from "./agent/preset.js";
import { createInteractiveRouter } from "./interactive/router.js";
import { createApprovalBridge } from "./interactive/approval.js";
import { classifyIntent, Intent } from "./agent/intent.js";
import { resumeCommand } from "./commands/resume.js";
import { workspaceCommand } from "./commands/workspace.js";
import { steerCommand } from "./commands/steer.js";
import { setupCommand } from "./commands/setup.js";
import { createSetupFlow } from "./setup/setup-flow.js";
import { createWingPanel, type WebServerLike } from "./web/panel.js";
import { doctorCommand } from "./commands/doctor.js";
import { createDoctorPackage, pluginVersion } from "./doctor/package.js";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { SelectorItem } from "./interactive/selector.js";
import { createTurnSupervisor } from "./agent/turn-supervisor.js";
import { createSender } from "./outbound/sender.js";
import { createWecomSender } from "./outbound/wecom-sender.js";
import { WecomStreamCard } from "./outbound/wecom-stream-card.js";
import { createOutbox, describeError } from "./outbound/outbox.js";
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
  // ★ 2026-10-01：改为带上限与归档的写入（默认 16 MiB × 3 份），长期运行不再无限增长。
  const fileLog = (level: string, m: string) => {
    appendRotatingLine(logFile, `[${new Date().toISOString()}] [${level}] ${m}\n`);
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
  // 企微智能机器人线路（长连接；startBridge 内按 cfg.wecom 创建）
  let wecomClient: WecomClient | undefined;
  const getWecomClient = () => wecomClient;

  // ---------- 出站（sender + outbox） ----------
  const sender = createSender({ getClient: getLarkClient, logger });
  // 企微出站（依赖 wecomClient 延迟就绪；无回调帧时自动降级主动推送）
  const wecomSender = createWecomSender({ getClient: getWecomClient, logger });
  /** card JSON → 企微降级纯文本（企微一期无模板卡片，取 main_text / 全部文本元素） */
  const cardToWecomText = (card: unknown): string => {
    try {
      const json = typeof card === "string" ? JSON.parse(card) : (card as any);
      const elements = json?.body?.elements ?? [];
      const texts: string[] = [];
      for (const el of elements) {
        if (el?.tag === "markdown" && typeof el.content === "string") texts.push(el.content);
        else if (el?.tag === "div" && typeof el?.text?.content === "string") texts.push(el.text.content);
      }
      return texts.filter(Boolean).join("\n") || (typeof card === "string" ? card.slice(0, 2000) : JSON.stringify(card).slice(0, 2000));
    } catch {
      return typeof card === "string" ? card.slice(0, 2000) : String(card).slice(0, 2000);
    }
  };
  // ---------- M3 任务 1：ask-user-question 桥（monkey-patch ctx.userQuestions.ask） ----------
  // ★ 2026-10-01 企微线路修复：提问不再一律走飞书卡片。
  //   企微没有模板卡片 API，且企微路由的 sessionId 同样带 feishu: 前缀，
  //   旧逻辑按前缀判定 → 卡片发去飞书 API → 400 invalid open_id（真机坐实，降级文本也 400）。
  //   判定顺序与 outbox.deliver 完全一致：入站登记的平台表优先，启发式兜底。
  const questionPlatformOf = (chatId: string): "feishu" | "wecom" | undefined =>
    chatPlatform(chatId) ?? (isWecomChatId(chatId) ? "wecom" : undefined);
  const userQuestionBridge = createUserQuestionBridge({
    platformOf: questionPlatformOf,
    sendCard: (chatId, card) =>
      questionPlatformOf(chatId) === "wecom"
        ? wecomSender.sendText(chatId, cardToWecomText(card))
        : sender.sendCard(chatId, card),
    updateCard: (messageId, cardJson) => sender.updateCard(messageId, cardJson),
    sendText: (chatId, text) =>
      questionPlatformOf(chatId) === "wecom" ? wecomSender.sendText(chatId, text) : sender.sendText(chatId, text),
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
        if (env.platform === "wecom" || chatPlatform(env.chatId) === "wecom" || isWecomChatId(env.chatId)) { // D6/S6：显式标记优先，启发式仅兜底
          // ★ 企微线路：无模板卡片/表情 API → card 降级纯文本，reaction 忽略
          if (env.kind === "text") {
            await wecomSender.sendText(env.chatId, env.payload.text ?? "");
          } else if (env.kind === "card") {
            await wecomSender.sendText(env.chatId, cardToWecomText(env.payload.card));
          }
          return { ok: true };
        }
        if (env.kind === "text") {
          await sender.sendText(env.chatId, env.payload.text ?? "");
        } else if (env.kind === "card") {
          await sender.sendCard(env.chatId, env.payload.card);
        } else if (env.kind === "reaction" && env.payload.messageId && env.payload.emojiType) {
          await sender.addReaction(env.payload.messageId, env.payload.emojiType);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, retryable: true, error: describeError(err) };
      }
    },
    onStatsChange: (stats) => {
      status.refreshCounters({ outboxPending: stats.pending, outboxFailed: stats.failed });
    },
    // ★ P0-4（2026-10-02）：显式对齐基底（config.ts:126-130 maxAttempts:50）——
    //   旧实现未传，缺省 3 次 × 固定 2s ≈ 10.9s 内判死，限流窗口内必然丢消息（真机丢 3 条）
    maxRetries: 50,
    logger,
  });

  // ---------- 连接监督（M2：probe + 配额熔断 + 自动重连，WS 假死根因解决） ----------
  const quota = createQuotaGovernor(join(dir, "conn-history.jsonl"), { windowMinutes: 60, limit: 12 });
  // ★ 阿深验收修正（2026-10-02）：必须接线 logger —— 否则 wal.ts 里所有回收 / prune 日志
  //   都被 `deps.logger?.info?.()` 静默吞掉（实测重启后段数确实 550→1，但日志零痕迹，
  //   违反"不许静默成功"铁律）。
  const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal"), logger });
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
    // ★ 企微路由不进飞书补偿通道（listMessages 是飞书 API；真机实测拿企微 chatId 调它会每 30s 刷 429）
    isWecomRoute: (route) => route.sessionKey?.startsWith("wecom:") === true || chatPlatform(route.chatId) === "wecom",
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
    createStreamCard: (chatId) => {
      // ★ 企微线路：流式走 replyStream（无卡片/打字机），接口与 StreamingCard 对齐
      if (chatPlatform(chatId) === "wecom" || isWecomChatId(chatId)) { // D6：登记优先，启发式兜底
        return new WecomStreamCard(chatId, {
          sender: wecomSender,
          logger,
          onFallback: (cid, text) =>
            outbox.enqueue({
              dedupeKey: `${cid}:wecom-fallback:${text.length}:${Date.now()}`,
              chatId: cid,
              platform: "wecom", // S6：显式平台标记（会话过期后登记可能已清）
              kind: "text",
              payload: { kind: "text", text },
            }) as unknown as Promise<void>,
        });
      }
      return new StreamingCard(chatId, {
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
      });
    },
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

  // ★ X5（阶段5）：per-chat 权限覆盖存储（照抄 model-overrides 模式；原子写 + 解析失败 .bak）
  const permissionOverrides = createPermissionOverrideStore(join(dir, "permission-overrides.json"));

  // ---------- P0-3 runtime 可变状态（/mode 只对新消息生效：新建 agent 读 runtime） ----------
  // 拍板：当前运行 agent 权限不变更，避免中途改权限安全漏洞
  const runtime = {
    agentPreset: cfg.agentPreset,
    // ★ X5：全局权限模式降级为"默认值"——各会话可 override（permission-overrides.json 落盘）；
    //   未设置过 override 的会话用此值。这也是 getPermissionMode() 的回退语义。
    defaultPermissionMode: cfg.permissionMode as PermissionMode,
  };
  /** 校验 + 设置权限模式（非法返回 false）；★ X5 起改为 per-chat override（+chatId 参数） */
  const setPermissionMode = (mode: string, chatId?: string): boolean => {
    if (mode !== "read-only" && mode !== "workspace-write" && mode !== "danger-full-access") return false;
    if (chatId) {
      permissionOverrides.set(chatId, mode);
    } else {
      // 无 chatId（不应发生：命令层/卡片回调都带会话）——保守落默认值
      runtime.defaultPermissionMode = mode;
    }
    return true;
  };
  // ★ X5：defaultPermissionMode 已在 runtime 初始化时赋值（见上），此处不再重复赋值

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
    routeStore.remove(sessionKey(chatId, isWecomChatId(chatId) ? WECOM_SESSION_PREFIX : SESSION_PREFIX)); // 移除旧路由账目 → 下次 createAgent 全新创建
  };

  // 单选卡回调路由（依赖 runtime/modelRegistry/rotateSession/reply，须在 event-handler 之前创建）
  // ★ 回执 dedupeKey 带 Date.now() 唯一 token——同一张卡点两次不被 durableReply 去重吞（成熟桥接踩坑）
  const interactiveRouter = createInteractiveRouter({
    runtime: {
      getPermissionMode: () => runtime.defaultPermissionMode,
      setPermissionMode,
      getAgentPreset: () => runtime.agentPreset,
      setAgentPreset: (id: string) => { runtime.agentPreset = id; },
    },
    // ★ X5：提权身份校验（命令层与卡片回调共用同一判定，fail-closed）
    checkPermissionChange: (target, operatorId) =>
      checkPermissionChange({
        target: target as PermissionMode,
        operatorId,
        bossOpenId: cfg.bossOpenId,
        wecomBossUserId: cfg.wecomBossUserId,
      }),
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
    // ★ Bug3b：审批卡改直发 sender.sendCard（返回 SDK 响应 → 取 message_id → 决策后 updateCard 收口换状态卡）。
    //   原走 outbox（磁盘持久化重试）拿不到 message_id 无法收口；代价 = 断联重启不补发（对齐提问卡，Alan 拍板 2026-09-05）
    sendCard: (chatId, card) => sender.sendCard(chatId, card),
    updateCard: (messageId, cardJson) => sender.updateCard(messageId, cardJson),
    messageIdOf: messageIdOfRes,
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
    // ★ 2026-10-01 企微线路：审批在企微降级为编号文本（复用与提问桥同一份线路判定）
    platformOf: questionPlatformOf,
    // 企微老板 userid 未配置 → 文本审批仅限私聊（群聊必须走卡片），并在非私聊时留痕
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
        return { kind: "error", text: describeError(err) };
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
    const platformPrefix = msg.platform === "wecom" ? WECOM_SESSION_PREFIX : SESSION_PREFIX;
    const cmdName = routed.kind === "bridge" ? routed.command.name : routed.name;
    let reply: string | undefined;
    let replyCard: Record<string, unknown> | undefined;
    let doneReaction = routed.kind === "bridge"; // 桥命令执行成功打 DONE（对齐基底成熟桥接命令路由）
    if (routed.kind === "bridge") {
      const res = await routed.command
        .run({ logger, services: commandServices }, routed.rawInput, msg)
        .catch((err: unknown): { text?: string; card?: Record<string, unknown> } => ({
          text: `⚠️ 命令执行失败: ${describeError(err)}`,
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
    const key = sessionKey(msg.chatId, platformPrefix);
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
    onStepStart: (chatId, step) => experience.onStepStart(chatId, step),
    onStepEnd: (chatId, step) => experience.onStepEnd(chatId, step),
    onChunk: (chatId, text) => experience.onChunk(chatId, text),
    onThinking: (chatId, text) => experience.onThinking(chatId, text),
    onAssistantMessage: (chatId, text) => void experience.onAssistantMessage(chatId, text),
    onTurnEnd: (chatId, reason) => void experience.onTurnEnd(chatId, reason),
    onToolCall: (chatId, name, input) => void experience.onToolCall(chatId, name, input),
    onToolResult: (chatId, name, error) => void experience.onToolResult(chatId, name, error),
    onContext: (chatId, text) => void experience.onContext(chatId, text),
  });

  // ---------- session 映射（createAgent 工厂：resume 优先，权限应用） ----------
  const makeAgentDeps = (sessionPrefix: string) => ({
    ctx,
    sessionPrefix, // ★ 会话 id 平台前缀（企微必须 wecom:，否则 sessionId 落回 feishu:）
    workspaceRoot: cfg.workspaceRoot,
    agentPreset: runtime.agentPreset,
    // ★ X5：按会话解析权限（override 优先，未设置 → 配置默认值）
    resolvePermission: (chatId: string) => permissionOverrides.resolveFor(chatId, runtime.defaultPermissionMode),
    onSessionEvent: (chatId: string, event: Parameters<typeof forwarder.onSessionEvent>[1]) =>
      forwarder.onSessionEvent(chatId, event),
    // P1-2 live 模型对象（/model 手动 override 优先；mutate 即对已存在 agent 生效）
    getModelLive: (chatId: string) => modelRegistry.liveFor(chatId),
    logger,
  });

  mapper = createSessionMapper<WingAgentHandle>({
    async createAgent(chatId: string): Promise<WingAgentHandle> {
      // ★ 企微适配：按 chatId 判定平台前缀（企微 userid/chatid 无 oc_/ou_ 前缀，启发式）
      const prefix = isWecomChatId(chatId) ? WECOM_SESSION_PREFIX : SESSION_PREFIX;
      const key = sessionKey(chatId, prefix);
      const existing = routeStore.get(key);
      if (existing?.sessionId) {
        try {
          const handle = await resumeAgent(makeAgentDeps(prefix), existing.sessionId);
          routeStore.upsert({ ...existing, sessionId: handle.sessionId, updatedAt: Date.now() });
          return handle;
        } catch (err) {
          logger.warn?.(`resume 失败（${existing.sessionId}），创建新 session: ${describeError(err)}`);
        }
      }
      const handle = await createAgent(makeAgentDeps(prefix), chatId);
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
      // ★ 企微适配：会话 key 按平台隔离（feishu:/wecom:），避免 chatId 撞车
      const platformPrefix = msg.platform === "wecom" ? WECOM_SESSION_PREFIX : SESSION_PREFIX;
      if (msg.platform === "wecom") rememberPlatform(msg.chatId, "wecom"); // D6：入站即登记，供 outbox/StreamCard 分发
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
      // ★ 2026-10-01 企微线路：待审批的文本回执（1=允许一次 / 2=本会话 / 3=永久 / 4=拒绝）
      //   与提问桥并列：提问优先（同时待答时先消费提问），审批次之；两者都未命中才进正常流程
      if (approvalBridge.onTextInbound(msg.chatId, msg.text, { operatorId: msg.userId, chatType: msg.chatType })) {
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
        const key = sessionKey(msg.chatId, platformPrefix);
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
        const key = sessionKey(msg.chatId, platformPrefix);
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
    keywords: () => (cfg as { groupKeywords?: string[] }).groupKeywords ?? ["lark", "wing"],
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
  // M4.2 /setup 核心流程（飞书 /setup 与 Web 面板共用；restart 闭包引用后文定义的 stop/startBridge）
  const setupFlow = createSetupFlow({
    persist: async (c) => { await credStore.set(cfg.credentialRef, c); },
    // ★ 企微扫码绑定流程（写独立凭据 ref WING_WECOM_BOT；凭证文件已被 .gitignore 屏蔽）
    wecom: {
      persist: async (c) => { await credStore.set("WING_WECOM_BOT", c); },
      // ★ A 修复（D7a 接线）：此前 setup-flow 读 deps.wecom?.source 但此处从未赋值 → 配置恒为惰性
      source: cfg.wecom.source,
      notify: (chatId) => {
        if (!chatId) return; // N5：面板触发（chatId=undefined）不产生幽灵 outbox 记录
        outbox.enqueue({
          dedupeKey: `wecom-setup:done:${chatId}`,
          chatId,
          platform: "wecom", // S6：显式平台标记（setup 通知非入站路径，无登记兜底）
          kind: "text",
          payload: {
            kind: "text",
            text: "✅ **企微智能机器人已绑定并重启连接！**\n\n在企业微信里私聊机器人即可对话（群聊需 @ 机器人）。",
          },
        });
      },
      failNotify: (chatId, message) => {
        if (!chatId) return; // N5：面板触发（chatId=undefined）不产生幽灵 outbox 记录
        outbox.enqueue({
          dedupeKey: `wecom-setup:fail:${chatId}:${Date.now()}`,
          chatId,
          platform: "wecom", // S6：显式平台标记
          kind: "text",
          payload: { kind: "text", text: `❌ 企微扫码绑定失败：${message}` },
        });
      },
      onStatus: (m) => logger.info?.(`wecom setup: ${m}`),
    },
    restart: async () => { await stopBridge(); await startBridge(); },
    notify: (chatId, appId, domain) => {
      outbox.enqueue({
        dedupeKey: `setup:done:${chatId}:${appId}`,
        chatId,
        kind: "text",
        payload: {
          kind: "text",
          text: [
            "✅ **机器人已就绪，连接已重启！**",
            "",
            `App ID：\`${appId}\``,
            `域：${domain === "lark" ? "Lark（国际版）" : "Feishu（国内版）"}`,
            `凭据已写入 \`${cfg.credentialRef}\`。`,
            "",
            "直接发消息试试。需要换机器人？重新 /setup，或 DSH 网页左下角扫码。",
          ].join("\n"),
        },
      });
    },
    failNotify: (chatId, message) => {
      outbox.enqueue({
        dedupeKey: `setup:fail:${chatId}:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text: `❌ 扫码建应用失败：${message}` },
      });
    },
    logger,
  });
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
      // ★ X5（阿深收口）：原先此处漏改（仍引用已删除的 runtime.permissionMode → typecheck 红）。
      //   getPermissionMode 保留为"配置默认值"（未指定会话时的回退）；
      //   getPermissionModeFor 才是各会话的真实取值（override ?? 默认值）。
      getPermissionMode: () => runtime.defaultPermissionMode,
      getPermissionModeFor: (chatId: string) =>
        permissionOverrides.resolveFor(chatId, runtime.defaultPermissionMode),
      setPermissionMode, // 提取共用：runtime/interactiveRouter/命令层同一校验
      checkPermissionChange: (target: string, operatorId?: string) =>
        checkPermissionChange({
          target: target as PermissionMode,
          operatorId,
          bossOpenId: cfg.bossOpenId,
          wecomBossUserId: cfg.wecomBossUserId,
        }),
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
    // M4.2 /doctor 诊断包
    doctor: {
      generate: async () => {
        const credential = await credStore.resolve(cfg.credentialRef);
        return createDoctorPackage({ stateDir: dir, cfg, credential, pluginVersion: pluginVersion() });
      },
    },
    // M4.2 /setup 扫码建应用（核心流程由 setupFlow 承担：后台注册 → 扫码 → 写凭据 → 重启桥 → 完成通知）
    setup: {
      start: (chatId) => setupFlow.start(chatId),
      startWecom: (chatId) => setupFlow.startWecom(chatId),
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
  bridgeCommands.set("doctor", doctorCommand);

  /** 企微智能机器人线路启动（长连接；可选，未配置/缺凭据不阻塞飞书主线路） */
  const startWecomBridge = async (): Promise<void> => {
    const wc = cfg.wecom; // S1：enabled?: boolean（缺省 undefined）
    // R1/M1：凭据走 resolveRaw（不经飞书 appId/appSecret 形状过滤），每次调用动态读，不受 cfg 冻结影响
    const wcCred = await credStore.resolveRaw<{ botId?: string; secret?: string }>("WING_WECOM_BOT");
    const botId = wc.botId ?? wcCred?.botId;
    const secret = wc.secret ?? wcCred?.secret;
    if (wc.enabled === false) { logger.info?.("企微线路已显式关闭（wecom.enabled=false），跳过启动"); return; }
    const active = wc.enabled === true || Boolean(wcCred); // 三态：true 开 / undefined 有凭据开 / false 关
    if (!active) { logger.info?.("企微线路未启用（wecom.enabled 未开启且无 WING_WECOM_BOT 凭据）"); return; }
    if (!botId || !secret) {
      logger.warn?.("企微线路启用但缺少 botId/secret：可用 /setup wecom 扫码绑定，或配置 WECOM_BOT_ID / WECOM_BOT_SECRET");
      return;
    }
    const client = createWecomClient({ botId, secret, logger });
    client.onMessage((frame) => {
      // D2/A：botName 精确触发群聊 @ 机器人名；未配置时 parser 内维持宽松并提示
      const msg = parseWecomInbound(frame.body as any, { botName: wc.botName });
      if (!msg) return;
      // ★ G5（批次 3）：企微群聊走与飞书侧同一套 group-policy（index.ts:748 同源）。
      //   旧实现完全没有群策略判定 → groupPolicy: mention 对企微失效，群里任何非寒暄
      //   消息都触发 agent 刷屏烧算力（体检 G5；wecom-parser.ts:5-7 注释与实现矛盾）。
      //   shouldProcessGroupMessage 的 mention 分支已含企微适配（@ 任何成员即命中）；
      //   p2p 恒 true，私聊主场景不受影响。
      if (msg.chatType === "group" && !groupPolicy.shouldProcess(msg)) {
        logger.info?.(`企微群消息被群策略过滤（policy=${(cfg as { groupPolicy?: string }).groupPolicy}）chat=${msg.chatId}`);
        return;
      }
      // S5：首条群聊消息诊断日志（核对 botName 与企微后台显示名是否一致；进程内一次）
      if (msg.chatType === "group" && consumeWecomGroupDiag()) {
        logger.info?.(`企微首条群聊 diag: chat=${msg.chatId} mentions=${JSON.stringify(msg.mentions)} raw="${msg.rawText.slice(0, 80)}"`);
      }
      void dispatcher.handleParsed(msg).catch((err) =>
        logger.error?.(`企微消息处理失败: ${describeError(err)}`),
      );
    });
    client.onEvent((frame) => {
      const body = frame.body as { event?: { eventtype?: string }; from?: { userid?: string }; chatid?: string } | undefined;
      if (body?.event?.eventtype === "enter_chat" && body.from?.userid) {
        const chatId = body.chatid ?? body.from.userid;
        void client.replyWelcome(frame, { msgtype: "text", text: { content: wc.welcomeText } }).catch(() => void 0);
      }
    });
    // ★ G4（批次 3）：企微连接状态写入 status.json（旧实现只写日志，面板完全看不出企微死活）
    client.onConnState((connected) => {
      logger.info?.(`企微连接 ${connected ? "已认证" : "断开/重连中"}`);
      status.update({
        wecomConnState: connected ? "connected" : "disconnected",
        wecomReady: connected,
      });
    });
    wecomClient = client;
    await client.start();
    logger.info?.("企微线路已启动（长连接模式）");
  };

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
        // ★ 批次 3 施工项 1（G15）：SDK WS 状态回调接进 supervisor——
        //   旧实现没传此参数，四个回调全部无人接收，supervisor 的 wsReady()/isConnected()
        //   永远反映启动那一刻的快照（体检 G15 根因）。
        onWsState: (s, d) => supervisor.notifyWsState(s, d),
      });
      // 3) outbox 启动
      // ★ L14（2026-10-02 阶段4）：删除显式 rebuildFromDisk()——start() 内部已调用，
      //   旧写法每次启动同步 IO 读两遍全部段文件，日志出现两行相同的「outbox 重建：…」。
      await outbox.start();
      // 4) 轮次监督
      turnSupervisor.start();
      // 5) 入站 WAL 重放（崩溃补发）
      // ★ P0-2（2026-10-02）：改走 dispatcher.handleCompensated（跳过去重）——
      //   旧实现走 handleEvent，凡进 WAL 的 messageId 必已在其去重表里（TTL 24h > 重放窗口），
      //   100% 被 isDuplicate 拦死，replayed 却照加、日志谎报"重放 N 条"。
      //   replayed 只在 handleInbound 真正成功后计数；failed/skipped 分开计数并打全三个数。
      inboundWal.prune();
      let replayed = 0;
      let replayFailed = 0;
      let replaySkipped = 0;
      for (const rec of inboundWal.pendingReplays()) {
        if (!inboundWal.markReplay(rec.messageId)) {
          replaySkipped += 1;
          continue;
        }
        const outcome = await dispatcher.handleCompensated("im.message.receive_v1", {
          message: {
            message_id: rec.messageId,
            chat_id: rec.chatId,
            chat_type: rec.chatType,
            message_type: "text",
            content: JSON.stringify({ text: rec.text }),
          },
        });
        if (outcome === "processed") {
          replayed += 1;
        } else if (outcome === "failed") {
          replayFailed += 1;
          logger.warn?.(`WAL 重放失败 ${rec.messageId}: handleInbound 未成功（state=replayed，超次前仍可补发）`);
        } else {
          replaySkipped += 1;
        }
      }
      if (replayed > 0 || replayFailed > 0 || replaySkipped > 0) {
        logger.info?.(`入站 WAL 重放：成功 ${replayed} / 失败 ${replayFailed} / 跳过 ${replaySkipped}`);
      }
      status.refreshCounters({ inboundPending: inboundWal.pendingCount() });
      // 6) 连接监督启动（含 WS 连接 + 探活 + 自动重连）
      await supervisor.start();
      // P1-2 模型 GUI 同步（10s 轮询 currentSelection，GUI 切模型 → 桥跟随无 override 会话）
      modelSync.start();
      // 7) 企微智能机器人线路（长连接；可选，未配置不阻塞飞书）
      await startWecomBridge();
      lifecycleStarted = true;
      startBlocker = undefined;
      logger.info?.("bridge started (M2 + P1-2 model sync)");
    } catch (err) {
      startBlocker = describeError(err);
      logger.error?.(`bridge 启动失败: ${startBlocker}`);
    }
  };

  const stopBridge = async (): Promise<void> => {
    if (!lifecycleStarted) return;
    modelSync.stop();
    turnSupervisor.stop();
    if (wecomClient) {
      await wecomClient.stop().catch(() => void 0);
      wecomClient = undefined;
    }
    await supervisor.stop(); // 内部先 transport.stop（CLOSE frame）
    await outbox.stop();
    // ★ M4 终审风险2：桥停止前 abort 所有 pending，避免残留 Promise 悬挂
    const aborted = userQuestionBridge.abortAll();
    if (aborted > 0) logger.info?.(`桥停止：abort ${aborted} 个待答提问`);
    await mapper?.disposeAll();
    lifecycleStarted = false;
    logger.info?.("bridge stopped");
  };

  // M4.2 Web 面板后端 route（status / qr / setup）。
  // webServer 是 cordis service（dsh-host-webserver 提供，isolate 到 host）。
  // 用 ctx.inject 声明依赖：测试等无 webServer 的 host 下子插件静默 INACTIVE
  // （不崩主插件）；webServer 之后注册时 cordis 会自动激活本子插件。
  ctx.inject(["webServer"], (webCtx: { webServer: WebServerLike }) => {
    const panel = createWingPanel({
      status,
      resolveCredential: async () => credStore.resolve(cfg.credentialRef),
      setup: {
        start: (chatId) => setupFlow.start(chatId),
        getActiveQr: () => setupFlow.getActiveQr(),
        isBusy: () => setupFlow.isBusy(),
      },
      wecomSetup: {
        start: () => setupFlow.startWecom(undefined),
        getQr: () => setupFlow.getWecomQr(),
        isBusy: () => setupFlow.isWecomBusy(),
        hasCredential: async () => Boolean(await credStore.resolveRaw("WING_WECOM_BOT")),
      },
      logger,
    });
    return panel.register(webCtx.webServer);
  });

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
