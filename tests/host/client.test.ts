import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mock 容器：捕获 SDK 实例，供测试触发回调/断言调用
const h = vi.hoisted(() => ({
  clients: [] as any[],
  wsClients: [] as any[],
  dispatchers: [] as any[],
  defaultHttpInstance: { defaults: { proxy: "http://127.0.0.1:10808" } },
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "DOMAIN_FEISHU", Lark: "DOMAIN_LARK" },
  AppType: { SelfBuild: "APP_SELF" },
  LoggerLevel: { debug: "DEBUG", error: "ERROR" },
  Client: vi.fn(function (this: any, opts: any) {
    const self: any = {
      opts,
      request: vi.fn(),
      im: {
        message: { create: vi.fn(), patch: vi.fn(), list: vi.fn() },
        messageReaction: { create: vi.fn() },
      },
    };
    h.clients.push(self);
    return self;
  }),
  EventDispatcher: vi.fn(function (this: any, opts: any) {
    const self: any = { opts, register: vi.fn() };
    h.dispatchers.push(self);
    return self;
  }),
  WSClient: vi.fn(function (this: any, opts: any) {
    const self: any = {
      opts,
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      getConnectionStatus: vi.fn().mockReturnValue("connected"),
    };
    h.wsClients.push(self);
    return self;
  }),
  defaultHttpInstance: h.defaultHttpInstance,
}));

import * as lark from "@larksuiteoapi/node-sdk";
import { buildLarkClient } from "../../src/host/client.js";

function lastClient() {
  return h.clients[h.clients.length - 1];
}
function lastWs() {
  return h.wsClients[h.wsClients.length - 1];
}
function lastDispatcher() {
  return h.dispatchers[h.dispatchers.length - 1];
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "wing-sdklog-")), "sdk.log");
}

describe("buildLarkClient", () => {
  beforeEach(() => {
    h.clients.length = 0;
    h.wsClients.length = 0;
    h.dispatchers.length = 0;
    h.defaultHttpInstance.defaults.proxy = "http://127.0.0.1:10808";
  });

  it("domain=feishu → SDK Domain.Feishu", () => {
    buildLarkClient({ appId: "a", appSecret: "s", domain: "feishu" });
    expect(lastClient().opts.domain).toBe("DOMAIN_FEISHU");
  });

  it("domain=lark → SDK Domain.Lark", () => {
    buildLarkClient({ appId: "a", appSecret: "s", domain: "lark" });
    expect(lastClient().opts.domain).toBe("DOMAIN_LARK");
  });

  it("默认禁 SDK 代理（DSH_WING_SDK_LOG 未设置时仍禁）", () => {
    buildLarkClient({ appId: "a", appSecret: "s" });
    expect(h.defaultHttpInstance.defaults.proxy).toBe(false);
  });

  it("on 注册事件 → EventDispatcher.register 转发", () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    const handler = vi.fn();
    client.on("im.message.receive_v1", handler);
    expect(lastDispatcher().register).toHaveBeenCalledWith({ "im.message.receive_v1": handler });
  });

  it("ws.start → WSClient.start({eventDispatcher})", () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    client.ws.start();
    expect(lastWs().start).toHaveBeenCalledWith({ eventDispatcher: lastDispatcher() });
  });

  it("ws.start 抛错 → logger.error 不崩溃", () => {
    const logger = { error: vi.fn() };
    const client = buildLarkClient({ appId: "a", appSecret: "s", logger });
    lastWs().start.mockImplementation(() => {
      throw new Error("sdk start boom");
    });
    client.ws.start();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("ws start failed"));
  });

  it("ws.stop → WSClient.stop", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    await client.ws.stop();
    expect(lastWs().stop).toHaveBeenCalled();
  });

  it("onReady → isWsReady true + onWsState ready；onError → false", () => {
    const onWsState = vi.fn();
    const client = buildLarkClient({ appId: "a", appSecret: "s", onWsState });
    expect(client.isWsReady()).toBe(false);
    lastWs().opts.onReady();
    expect(client.isWsReady()).toBe(true);
    expect(onWsState).toHaveBeenCalledWith("ready");
    lastWs().opts.onError(new Error("conn lost"));
    expect(client.isWsReady()).toBe(false);
    expect(onWsState).toHaveBeenCalledWith("error", "conn lost");
  });

  it("onReconnecting / onReconnected → onWsState 透出", () => {
    const onWsState = vi.fn();
    buildLarkClient({ appId: "a", appSecret: "s", onWsState });
    lastWs().opts.onReconnecting();
    expect(onWsState).toHaveBeenCalledWith("reconnecting");
    lastWs().opts.onReconnected();
    expect(onWsState).toHaveBeenCalledWith("reconnected");
  });

  it("getBotInfo → request 取 open_id + app_name（bot 包裹）", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().request.mockResolvedValue({ bot: { open_id: "ou_bot", app_name: "dsh-wing" } });
    const info = await client.getBotInfo();
    expect(info).toEqual({ open_id: "ou_bot", name: "dsh-wing" });
    expect(lastClient().request).toHaveBeenCalledWith({ url: "/open-apis/bot/v3/info", method: "GET" });
  });

  it("getBotInfo → data.bot 兼容路径", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().request.mockResolvedValue({ data: { bot: { open_id: "ou_d" }, open_id: "ou_d" } });
    expect((await client.getBotInfo()).open_id).toBe("ou_d");
  });

  it("sendMessage → im.message.create", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    await client.sendMessage({ receive_id_type: "chat_id", params: { receive_id: "oc_1", msg_type: "text", content: "{}" } });
    expect(lastClient().im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "oc_1", msg_type: "text", content: "{}" },
    });
  });

  it("updateMessage → im.message.patch（仅 content）", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    await client.updateMessage({ message_id: "om_1", content: '{"schema":"2.0"}' });
    expect(lastClient().im.message.patch).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { content: '{"schema":"2.0"}' },
    });
  });

  it("createCardEntity → request POST → card_id", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().request.mockResolvedValue({ data: { card_id: "cc_1" } });
    expect(await client.createCardEntity!('{"type":"card_json"}')).toBe("cc_1");
    expect(lastClient().request).toHaveBeenCalledWith({
      url: "/open-apis/cardkit/v1/cards",
      method: "POST",
      data: { type: "card_json", data: '{"type":"card_json"}' },
    });
  });

  it("createCardEntity 无 card_id → throw", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().request.mockResolvedValue({});
    await expect(client.createCardEntity!("x")).rejects.toThrow("无 card_id");
  });

  it("streamMessageContent → request PUT content+sequence", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    await client.streamMessageContent!("cc_1", "正文", 3);
    expect(lastClient().request).toHaveBeenCalledWith({
      url: "/open-apis/cardkit/v1/cards/cc_1/elements/main_text/content",
      method: "PUT",
      data: { content: "正文", sequence: 3 },
    });
  });

  it("addReaction → im.messageReaction.create", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    await client.addReaction({ message_id: "om_1", emoji_type: "THUMBSUP" });
    expect(lastClient().im.messageReaction.create).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { reaction_type: { emoji_type: "THUMBSUP" } },
    });
  });

  it("listMessages → message.list 映射 items", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().im.message.list.mockResolvedValue({
      items: [{ message_id: "om_a", create_time: "1700000000000" }],
    });
    const res = await client.listMessages!({ container_id_type: "chat", container_id: "oc_1" });
    expect(res).toEqual([{ messageId: "om_a", timestampMs: 1700000000000 }]);
    expect(lastClient().im.message.list).toHaveBeenCalledWith({ params: { container_id_type: "chat", container_id: "oc_1", page_size: 50 } });
  });

  it("listMessages data.items 兼容 + 缺省空数组", async () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    lastClient().im.message.list.mockResolvedValue({ data: { items: [{ message_id: "om_b" }] } });
    expect((await client.listMessages!({})).length).toBe(1);
    lastClient().im.message.list.mockResolvedValue({});
    expect(await client.listMessages!({})).toEqual([]);
  });

  it("connectionStatus → getConnectionStatus 透出", () => {
    const client = buildLarkClient({ appId: "a", appSecret: "s" });
    expect(client.connectionStatus!()).toBe("connected");
  });

  it("DSH_WING_SDK_LOG 设置 → loggerLevel debug 且 logger 提供", async () => {
    const logFile = tmpFile();
    const old = process.env.DSH_WING_SDK_LOG;
    process.env.DSH_WING_SDK_LOG = logFile;
    try {
      buildLarkClient({ appId: "a", appSecret: "s" });
      expect(lastClient().opts.loggerLevel).toBe("DEBUG");
      expect(lastClient().opts.logger).toBeTruthy();
      // SDK logger 写文件不崩溃
      lastClient().opts.logger.info("hello");
    } finally {
      if (old === undefined) delete process.env.DSH_WING_SDK_LOG;
      else process.env.DSH_WING_SDK_LOG = old;
      rmSync(join(logFile, ".."), { recursive: true, force: true });
    }
  });
});
