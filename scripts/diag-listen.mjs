/**
 * WS 消息监听诊断（M2 排障）
 * 独立进程监听 dsh-wing App 的 WS 消息 60 秒，判断"App 侧推送" vs "DSH 进程侧接收"。
 * 运行期间请 ALAN 从飞书给 dsh-wing bot 发一条消息。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as lark from "@larksuiteoapi/node-sdk";

// 凭据文件位置：DSH_HOME 优先，兜底用户主目录（不硬编码本机路径）
const yaml = readFileSync(`${process.env.DSH_HOME ?? homedir()}/.credentials.yaml`, "utf8");
const m = yaml.match(/WING_LARK_APP:\s*'([^']+)'/);
if (!m) {
  console.log("NO WING_LARK_APP");
  process.exit(1);
}
const cred = JSON.parse(m[1]);
console.log("appId:", cred.appId);

const dh = lark.defaultHttpInstance;
if (dh?.defaults) dh.defaults.proxy = false;

const wsClient = new lark.WSClient({
  appId: cred.appId,
  appSecret: cred.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: cred.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.info,
  wsConfig: { pingTimeout: 60 },
  onReady: () => console.log(`[${new Date().toISOString()}] WS READY`),
  onError: (e) => console.log(`[${new Date().toISOString()}] WS ERROR: ${e?.message ?? String(e)}`),
  onReconnecting: () => console.log(`[${new Date().toISOString()}] RECONNECTING`),
  onReconnected: () => console.log(`[${new Date().toISOString()}] RECONNECTED`),
});

const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error });
dispatcher.register({
  "im.message.receive_v1": (data) => {
    const msg = data?.message ?? data;
    console.log(`[${new Date().toISOString()}] MSG RECEIVED: ${msg?.message_id} type=${msg?.message_type}`);
  },
});
wsClient.start({ eventDispatcher: dispatcher });
console.log(`[${new Date().toISOString()}] listening 60s — 请 ALAN 现在从飞书给 dsh-wing bot 发一条消息`);

setTimeout(() => {
  const status = wsClient.getConnectionStatus?.();
  console.log(`[${new Date().toISOString()}] DONE status=${JSON.stringify(status)}`);
  process.exit(0);
}, 60_000);
