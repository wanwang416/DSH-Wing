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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { getConfig, type WingConfig } from "./config/defaults.js";
import { createCredentialStore } from "./host/credentials.js";
import { buildLarkClient, type WingLarkClient } from "./host/client.js";
import { createTransport } from "./host/websocket.js";
import { parseInboundMessage, type ParsedMessage } from "./inbound/parser.js";
import { createDedupeStore } from "./inbound/dedup.js";
import { createDispatcher } from "./inbound/dispatcher.js";
import { sessionKey, createSessionMapper } from "./session/mapper.js";
import { createRouteStore } from "./session/persistence.js";
import { createSerialQueue } from "./session/serial.js";
import { createAgent, resumeAgent, type WingAgentHandle } from "./agent/caller.js";
import { createForwarder } from "./agent/forwarder.js";
import { createExperience } from "./agent/experience.js";
import { createTurnSupervisor } from "./agent/turn-supervisor.js";
import { createSender } from "./outbound/sender.js";
import { createOutbox } from "./outbound/outbox.js";
import { createReactionManager } from "./interactive/reaction.js";

export const name = "dsh-wing";

export const inject = ["tools", "commands", "agents", "systemPrompt", "credentials"];

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
  const logger = {
    info: (m: string) => ctx.logger?.info?.(`[dsh-wing] ${m}`),
    warn: (m: string) => ctx.logger?.warn?.(`[dsh-wing] ${m}`),
    error: (m: string) => ctx.logger?.error?.(`[dsh-wing] ${m}`),
  };

  // M0 遗留：加载 marker（证明插件被 DSH 加载；非 DSH 环境忽略）
  try {
    const home = process.env.DSH_HOME ?? "本地目录";
    writeFileSync(join(home, ".dsh-wing-loaded"), `loaded at ${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // 忽略
  }

  // ---------- 状态存储 ----------
  const routeStore = createRouteStore(join(dir, "routes.json"));
  const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));

  // ---------- 凭据 + 客户端 ----------
  const credStore = createCredentialStore(ctx);
  let larkClient: WingLarkClient | undefined;
  const getLarkClient = () => larkClient;

  // ---------- 出站（sender + outbox） ----------
  const sender = createSender({ getClient: getLarkClient, logger });
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
    logger,
  });

  // ---------- 表情 + 轮次监督 ----------
  const reactionManager = createReactionManager({
    addReaction: (messageId, emoji) => sender.addReaction(messageId, emoji),
    enabled: () => cfg.reactions.enabled,
  });
  let mapper: ReturnType<typeof createSessionMapper> | undefined;
  const turnSupervisor = createTurnSupervisor({
    timeoutMs: cfg.turnTimeoutMs,
    onTimeout(key) {
      void mapper?.disposeAgentFor?.(key).catch(() => void 0);
    },
    logger,
  });

  // ---------- 体验契约（流式/插话/工具可见/表情） ----------
  const experience = createExperience({
    sendText: (chatId, text) =>
      outbox.enqueue({
        dedupeKey: `${chatId}:text:${text.length}:${Date.now()}`,
        chatId,
        kind: "text",
        payload: { kind: "text", text },
      }) as unknown as Promise<void>,
    addReaction: (messageId, emoji) =>
      reactionManager.react(messageId, emoji) as unknown as Promise<void>,
    turnSupervisor,
    cfg: () => cfg,
    logger,
  });

  // ---------- 事件转发（6 种事件 → 体验） ----------
  const forwarder = createForwarder({
    onTurnStart: (chatId) => experience.onTurnStart(chatId),
    onChunk: (chatId, text) => experience.onChunk(chatId, text),
    onAssistantMessage: (chatId, text) => void experience.onAssistantMessage(chatId, text),
    onTurnEnd: (chatId, reason) => void experience.onTurnEnd(chatId, reason),
    onToolCall: (chatId, name) => void experience.onToolCall(chatId, name),
    onToolResult: (chatId, name, error) => void experience.onToolResult(chatId, name, error),
  });

  // ---------- session 映射（createAgent 工厂：resume 优先，权限应用） ----------
  const makeAgentDeps = () => ({
    ctx,
    workspaceRoot: cfg.workspaceRoot,
    agentPreset: cfg.agentPreset,
    permissionMode: cfg.permissionMode,
    onSessionEvent: (chatId: string, event: Parameters<typeof forwarder.onSessionEvent>[1]) =>
      forwarder.onSessionEvent(chatId, event),
    logger,
  });

  mapper = createSessionMapper({
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
  const serialQueue = createSerialQueue();
  const dispatcher = createDispatcher({
    dedupe,
    botOpenId: () => transport.botOpenId(),
    logger,
    async handleInbound(msg: ParsedMessage) {
      await serialQueue.enqueue(msg.chatId, async () => {
        // 1) 收到表情 + reaction 目标
        experience.onInbound(msg.chatId, msg.messageId);
        // 2) 获取/创建 agent（resume 优先）
        const agent = await mapper!.getOrCreateAgent(msg.chatId);
        // 3) 构造用户消息
        const message = createUserMessage({
          content: [{ type: "text", text: msg.text }],
          source: { kind: "user" },
        });
        // 4) 插话/停止/排队（★体验契约）
        const action = experience.handleUserMessage(msg.chatId, agent, msg.text, message);
        logger.info?.(`chat=${msg.chatId} 消息 ${msg.messageId} → ${action}`);
        // 5) 路由 touch
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
      });
    },
  });

  // ---------- 传输层（WS + 单实例锁 + CLOSE frame） ----------
  const transport = createTransport({
    getClient: getLarkClient,
    onMessage: (data) => dispatcher.handleEvent("im.message.receive_v1", data),
    onEvent: (event, data) => {
      // M1：card.action.trigger 留 M3
      void event;
      void data;
    },
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
      // 5) 传输启动
      await transport.start();
      lifecycleStarted = true;
      startBlocker = undefined;
      logger.info?.("bridge started (M1)");
    } catch (err) {
      startBlocker = err instanceof Error ? err.message : String(err);
      logger.error?.(`bridge 启动失败: ${startBlocker}`);
    }
  };

  const stopBridge = async (): Promise<void> => {
    if (!lifecycleStarted) return;
    turnSupervisor.stop();
    await transport.stop(); // 先发 WS CLOSE frame（铁律 6）
    await outbox.stop();
    await mapper?.disposeAll();
    lifecycleStarted = false;
    logger.info?.("bridge stopped");
  };

  ctx.effect(() => {
    void startBridge();
    // ★ 基础探活（M2 连接自愈的雏形）：30s 真实 API 探活，连续 2 次失败重启 WS
    let probeFails = 0;
    const probeTimer = setInterval(() => {
      void (async () => {
        if (!lifecycleStarted) return;
        const ok = await transport.probe();
        if (ok) {
          probeFails = 0;
        } else {
          probeFails += 1;
          logger.warn?.(`WS 探活失败 ${probeFails}/2`);
          if (probeFails >= 2) {
            probeFails = 0;
            logger.warn?.("WS 疑似假死，重启传输连接…");
            await transport.stop();
            await transport.start();
          }
        }
      })();
    }, 30_000);
    probeTimer.unref?.();
    // 空闲清理：每 10 分钟 dispose 空闲 30 分钟的 agent
    const sweep = setInterval(() => {
      void (async () => {
        const n = (await mapper?.空闲清理(30 * 60_000)) ?? 0;
        if (n > 0) logger.info?.(`清理 ${n} 个空闲 agent`);
      })();
    }, 10 * 60_000);
    sweep.unref?.();
    return async () => {
      clearInterval(probeTimer);
      clearInterval(sweep);
      await stopBridge();
    };
  });
}
