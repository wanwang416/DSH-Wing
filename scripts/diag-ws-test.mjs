// 最小化飞书 WS 连接测试 -- dsh-wing 凭据
import lark from "@larksuiteoapi/node-sdk";

const APP_ID = process.env.DSH_WING_APP_ID ?? "";
const APP_SECRET = process.env.DSH_WING_APP_SECRET ?? "";

console.log("App ID:", APP_ID);
console.log("Domain: feishu");

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.debug,
});

const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.debug });

dispatcher.register({
  "im.message.receive_v1": (data) => {
    console.log("\n=== 收到消息! ===");
    console.log(JSON.stringify(data, null, 2)?.slice(0, 500));
  },
});

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  onReady: () => console.log("WS Ready!"),
  onError: (e) => console.log("WS Error:", e),
});

console.log("启动 WS 连接...等待 60 秒");
wsClient.start({ eventDispatcher: dispatcher });

setTimeout(() => {
  console.log("\n60 秒到期，退出");
  process.exit(0);
}, 60000);
