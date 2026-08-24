/**
 * WS 连接诊断脚本（临时，M1 排障用）
 * 从 .credentials.yaml 读 WING_LARK_APP 凭据（不硬编码），直接测 SDK WSClient。
 */
import { readFileSync } from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";

const yaml = readFileSync("本地目录/.credentials.yaml", "utf8");
const m = yaml.match(/WING_LARK_APP:\s*'([^']+)'/);
if (!m) {
  console.log("NO WING_LARK_APP credential");
  process.exit(1);
}
const cred = JSON.parse(m[1]);
console.log("appId:", cred.appId, "domain:", cred.domain);

const log = (msg) => console.log(`[diag ${new Date().toISOString()}] ${msg}`);

// 与插件相同：禁用默认 http 代理
const dh = lark.defaultHttpInstance;
if (dh?.defaults) {
  dh.defaults.proxy = false;
  console.log("proxy disabled (defaultHttpInstance)");
}

const wsClient = new lark.WSClient({
  appId: cred.appId,
  appSecret: cred.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: cred.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.debug,
  onReady: () => log("WS READY"),
  onError: (e) => log(`WS ERROR: ${e?.message ?? String(e)}`),
  onReconnecting: () => log("WS RECONNECTING"),
  onReconnected: () => log("WS RECONNECTED"),
});

const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.debug });
wsClient.start({ eventDispatcher: dispatcher });
log("wsClient.start() called");

setTimeout(() => {
  const status = wsClient.getConnectionStatus?.();
  log(`STATUS: ${JSON.stringify(status)}`);
  process.exit(0);
}, 15000);
