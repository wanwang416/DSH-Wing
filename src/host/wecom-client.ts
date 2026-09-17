/**
 * 企业微信智能机器人 WS 连接层（基于官方 @wecom/aibot-node-sdk）。
 *
 * SDK 内置：自动认证（aibot_subscribe）、30s 心跳、指数退避重连（1s→30s，默认 10 次）。
 * 本层职责：
 *   - 创建/启动/停止 WSClient；
 *   - 统一分发 message.* 与 event.* 事件（保持单一出口，方便 index.ts 装配）；
 *   - 维护「chatId → 最近回调帧」映射（企微回复必须携带帧 req_id；新消息替换旧帧，
 *     对齐哈马 replyFrames 策略）；
 *   - 暴露与 wecom-sender 约定的客户端接口。
 * 与飞书 websocket.ts 的差异：企微 SDK 自管心跳/重连，无需自建 supervisor 探活；
 * 连接状态通过事件上报给 status store。
 */

import { WSClient, type WsFrame } from "@wecom/aibot-node-sdk";

export interface WecomClientOptions {
  botId: string;
  secret: string;
  wsUrl?: string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export interface WecomClientHandlers {
  /** 消息回调（aibot_msg_callback 同构 body） */
  onMessage(frame: WsFrame): void;
  /** 事件回调（aibot_event_callback 同构 body：enter_chat / template_card_event / feedback_event） */
  onEvent(frame: WsFrame): void;
  /** 连接状态变化：true=已连接（authenticated），false=断开/重连中 */
  onConnState?(connected: boolean): void;
}

/** 消息帧 → 会话键（与 wecom-parser 同规则：单聊=userid，群聊=chatid） */
function chatIdOfFrame(frame: WsFrame): string | undefined {
  const body = frame.body as { chattype?: string; from?: { userid?: string }; chatid?: string } | undefined;
  if (!body) return undefined;
  if (body.chattype === "group") return body.chatid || undefined;
  return body.from?.userid || undefined;
}

export function createWecomClient(opts: WecomClientOptions) {
  let ws: WSClient | undefined;
  let started = false;
  let connState = false;
  /** chatId → 最近回调帧（新消息替换旧帧：回复总指向用户最后一条消息） */
  const replyFrames = new Map<string, WsFrame>();
  const messageHandlers: Array<(frame: WsFrame) => void> = [];
  const eventHandlers: Array<(frame: WsFrame) => void> = [];
  const connHandlers: Array<(connected: boolean) => void> = [];

  function setConnState(connected: boolean): void {
    if (connState === connected) return;
    connState = connected;
    for (const h of connHandlers) h(connected);
  }

  return {
    /** 订阅消息回调（可多个） */
    onMessage(h: (frame: WsFrame) => void): void {
      messageHandlers.push(h);
    },
    onEvent(h: (frame: WsFrame) => void): void {
      eventHandlers.push(h);
    },
    onConnState(h: (connected: boolean) => void): void {
      connHandlers.push(h);
    },

    isConnected(): boolean {
      return connState;
    },

    async start(): Promise<void> {
      if (started) return; // 内存级防重（SDK/企微侧单连接限制：重复连接会踢旧连）
      started = true;
      const logger = opts.logger;

      const client = new WSClient({
        botId: opts.botId,
        secret: opts.secret,
        ...(opts.wsUrl ? { wsUrl: opts.wsUrl } : {}),
        logger: {
          debug: () => {},
          info: (m: string) => logger?.info?.(`[wecom-sdk] ${m}`),
          warn: (m: string, ...a: unknown[]) => logger?.warn?.(`[wecom-sdk] ${m} ${a.join(" ")}`),
          error: (m: string, ...a: unknown[]) => logger?.error?.(`[wecom-sdk] ${m} ${a.join(" ")}`),
        },
      });
      ws = client;

      client.on("authenticated", () => {
        logger?.info?.("企微智能机器人连接已认证");
        setConnState(true);
      });
      client.on("disconnected", (reason: string) => {
        logger?.warn?.(`企微连接断开: ${reason}`);
        setConnState(false);
      });
      client.on("reconnecting", (attempt: number) => {
        logger?.info?.(`企微连接重连中（第 ${attempt} 次）`);
        setConnState(false);
      });
      client.on("error", (err: Error) => {
        logger?.error?.(`企微连接错误: ${err instanceof Error ? err.message : String(err)}`);
        setConnState(false);
      });

      // 统一消息分发 + 帧登记
      client.on("message", (frame: WsFrame) => {
        const chatId = chatIdOfFrame(frame);
        if (chatId) replyFrames.set(chatId, frame);
        for (const h of messageHandlers) h(frame);
      });
      // 统一事件分发（enter_chat 等）
      client.on("event", (frame: WsFrame) => {
        for (const h of eventHandlers) h(frame);
      });

      client.connect();
    },

    async stop(): Promise<void> {
      if (!ws) return;
      try {
        ws.disconnect();
      } catch {
        // 忽略
      }
      ws = undefined;
      started = false;
      setConnState(false);
      replyFrames.clear();
    },

    /** 取该会话最近回调帧（回复用）；无则 undefined（走主动推送兜底） */
    replyFrameFor(chatId: string): WsFrame | undefined {
      return replyFrames.get(chatId);
    },

    // ---- 与 wecom-sender 约定的客户端接口 ----
    async reply(frame: WsFrame, body: Record<string, unknown>): Promise<unknown> {
      if (!ws) throw new Error("企微客户端未就绪");
      return ws.reply(frame, body);
    },
    async replyStream(frame: WsFrame, streamId: string, content: string, finish?: boolean): Promise<unknown> {
      if (!ws) throw new Error("企微客户端未就绪");
      return ws.replyStream(frame, streamId, content, finish);
    },
    async sendMessage(chatId: string, body: Record<string, unknown>): Promise<unknown> {
      if (!ws) throw new Error("企微客户端未就绪");
      return ws.sendMessage(chatId, body as unknown as Parameters<typeof ws.sendMessage>[1]);
    },
    async sendMarkdown(chatId: string, body: Record<string, unknown>): Promise<unknown> {
      if (!ws) throw new Error("企微客户端未就绪");
      return ws.sendMessage(chatId, body as unknown as Parameters<typeof ws.sendMessage>[1]);
    },
    async replyWelcome(frame: WsFrame, body: Record<string, unknown>): Promise<unknown> {
      if (!ws) throw new Error("企微客户端未就绪");
      return ws.replyWelcome(frame, body as unknown as Parameters<typeof ws.replyWelcome>[1]);
    },
  };
}

export type WecomClient = ReturnType<typeof createWecomClient>;
