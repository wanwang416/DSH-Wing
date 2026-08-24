/**
 * 飞书 SDK 客户端封装
 *
 * 参考成熟桥接实现：
 * Client + EventDispatcher + WSClient 三件套。
 * WS 状态回调（onReady/onError/onReconnecting/onReconnected）为 M2 连接自愈打基础。
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { appendFileSync } from "node:fs";

export interface WingLarkClient {
  on(event: string, handler: (data: any) => void): void;
  ws: {
    start(): void;
    stop(): Promise<void>;
  };
  getBotInfo(): Promise<{ open_id?: string; name?: string }>;
  sendMessage(params: { receive_id_type: "chat_id" | "open_id"; params: Record<string, unknown> }): Promise<unknown>;
  /** 更新已发送的卡片消息（StreamingCard 单卡流式用） */
  updateMessage(params: { message_id: string; content: string }): Promise<unknown>;
  addReaction(params: { message_id: string; emoji_type: string }): Promise<unknown>;
  /** 拉取会话消息（丢消息补偿用，M2） */
  listMessages?(params: Record<string, unknown>): Promise<Array<{ messageId: string; timestampMs: number }>>;
  /** WS 连接状态（SDK getConnectionStatus 透出，诊断用） */
  connectionStatus?(): unknown;
  /** WS 是否已就绪（SDK onReady 触发后才 true） */
  isWsReady?(): boolean;
}

/** 构建飞书 SDK 客户端 */
export function buildLarkClient(opts: {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  logger?: { error?: (msg: string) => void };
  /** WS 状态回调（诊断 + M2 自愈基础） */
  onWsState?(state: string, detail?: string): void;
}): WingLarkClient {
  const domain = opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  // 诊断：SDK 日志落盘（M1 排障，验证后移除；DSH_WING_SDK_LOG 指向文件时启用）
  const sdkLogFile = process.env.DSH_WING_SDK_LOG ?? "";
  const sdkLogger = sdkLogFile
    ? {
        info: (msg: unknown) => {
          try {
            appendFileSync(sdkLogFile, `[info] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
          } catch {
            // 忽略
          }
        },
        error: (msg: unknown) => {
          try {
            appendFileSync(sdkLogFile, `[error] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
          } catch {
            // 忽略
          }
        },
        debug: (msg: unknown) => {
          try {
            appendFileSync(sdkLogFile, `[debug] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
          } catch {
            // 忽略
          }
        },
        warn: (msg: unknown) => {
          try {
            appendFileSync(sdkLogFile, `[warn] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
          } catch {
            // 忽略
          }
        },
        trace: (msg: unknown) => {
          try {
            appendFileSync(sdkLogFile, `[trace] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
          } catch {
            // 忽略
          }
        },
      }
    : undefined;
  const clientOpts = {
    appId: opts.appId,
    appSecret: opts.appSecret,
    appType: lark.AppType.SelfBuild,
    domain,
    loggerLevel: sdkLogFile ? lark.LoggerLevel.debug : lark.LoggerLevel.error,
    ...(sdkLogger ? { logger: sdkLogger } : {}),
  };
  const sdkClient = new lark.Client(clientOpts);
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error });
  // ★ 禁用 SDK 默认 http 代理（同 成熟桥接实现 Line 3523）：
  //   环境有 127.0.0.1:10808 系统代理，axios 走代理会导致 connect config 拉取失败
  const dh = (lark as unknown as { defaultHttpInstance?: { defaults?: { proxy?: unknown } } }).defaultHttpInstance;
  if (dh?.defaults) dh.defaults.proxy = false;
  let wsReady = false;
  const wsClient = new lark.WSClient({
    ...clientOpts,
    // ★ WS 假死检测（liveness watchdog）：SDK 每 120s 发 ping，
    //   ping 后 wsConfig.pingTimeout 秒内无帧即判定假死并触发重连。
    //   飞书长连接会静默断推（TCP 在但无事件），这是 成熟桥接 连接监督器解决的核心问题，
    //   M1 用 SDK 内置机制实现，M2 再做完整 supervisor。
    wsConfig: { pingTimeout: 60 },
    onReady: () => {
      wsReady = true;
      opts.onWsState?.("ready");
    },
    onError: (err: unknown) => {
      wsReady = false;
      opts.onWsState?.("error", err instanceof Error ? err.message : String(err));
    },
    onReconnecting: () => opts.onWsState?.("reconnecting"),
    onReconnected: () => {
      wsReady = true;
      opts.onWsState?.("reconnected");
    },
  } as never);

  return {
    on(event, handler) {
      dispatcher.register({ [event]: handler } as never);
    },
    ws: {
      start() {
        try {
          wsClient.start({ eventDispatcher: dispatcher });
        } catch (err) {
          opts.logger?.error?.(`ws start failed: ${err instanceof Error ? err.message : String(err)}`);
          // 排障：错误落盘（DSH_WING_SDK_LOG 未设置时默认路径）
          try {
            appendFileSync(process.env.DSH_WING_SDK_LOG ?? "本地目录\\wing\\ws-error.log", `${new Date().toISOString()} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          } catch {
            // 忽略
          }
        }
      },
      stop() {
        wsReady = false;
        // SDK 类型未声明 stop；运行时存在（成熟桥接实现 同款调用）
        return Promise.resolve((wsClient as unknown as { stop?: () => Promise<void> }).stop?.()).catch(() => void 0);
      },
    },
    /** WS 是否已就绪（SDK onReady 触发） */
    isWsReady: () => wsReady,
    async getBotInfo() {
      const res = (await sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      })) as any;
      const bot = res?.bot ?? res?.data?.bot;
      return {
        open_id: bot?.open_id ?? res?.data?.open_id,
        name: bot?.app_name,
      };
    },
    async sendMessage(params) {
      return sdkClient.im.message.create({
        params: { receive_id_type: params.receive_id_type },
        data: params.params as never,
      });
    },
    async updateMessage(params) {
      // StreamingCard 单卡流式：更新已发送的卡片消息
      return sdkClient.im.message.update({
        path: { message_id: params.message_id },
        data: { content: params.content } as never,
      });
    },
    async addReaction(params) {
      return sdkClient.im.messageReaction.create({
        path: { message_id: params.message_id },
        data: { reaction_type: { emoji_type: params.emoji_type } } as never,
      });
    },
    /** 拉取会话消息（丢消息补偿用，M2） */
    async listMessages(params) {
      const res = (await sdkClient.im.message.list({
        params: { ...params, page_size: 50 } as never,
      })) as any;
      return (res?.items ?? res?.data?.items ?? []).map((i: any) => ({
        messageId: i.message_id,
        timestampMs: Number(i.create_time ?? 0),
      }));
    },
    connectionStatus() {
      return (wsClient as unknown as { getConnectionStatus?: () => unknown }).getConnectionStatus?.();
    },
  };
}
