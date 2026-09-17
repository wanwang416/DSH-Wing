/**
 * /setup 扫码一键创建飞书机器人（M4.2）
 *
 * 全自动闭环（参考 dsh-lark-link /lark setup）：
 * 发起飞书官方应用注册 device-code 流程 → 返回授权链接 + ASCII 二维码 →
 * 用户扫码确认 → 后台拿到明文 appId/appSecret → 写 WING_LARK_APP →
 * 重启 bridge → 完成通知。权限 scope + 事件订阅在创建应用时一并配置。
 */
import type { BridgeCommandDef } from "./types.js";
import { toAsciiQr, qrHint } from "../setup/qrcode.js";

export const setupCommand: BridgeCommandDef = {
  name: "setup",
  description: "扫码一键创建飞书机器人并自动配置：/setup；企微智能机器人：/setup wecom",
  async run(deps, rawInput, msg) {
    const isWecom = rawInput.trim().toLowerCase() === "wecom";
    const start = isWecom ? deps.services?.setup?.startWecom : deps.services?.setup?.start;
    if (!start) return { text: "⚠️ setup 服务不可用，请稍后再试" };

    // 阻塞等待二维码就绪（最多 30s）；期间后台正在访问飞书发起注册
    const info = await start(msg.chatId);
    if (!info) {
      return {
        text: "⚠️ 扫码流程未在 30 秒内就绪（或上一个流程仍在进行）。请稍后重试 /setup。若多次失败，检查本机网络到 accounts.feishu.cn 的连通性。",
      };
    }

    const qr = await toAsciiQr(info.url);
    const lines: string[] = [
      isWecom ? "📱 **扫码绑定企业微信智能机器人**" : "📱 **扫码创建飞书机器人（换 bot 辅助）**",
      "",
      isWecom ? "用**企业微信**扫码授权（自动创建并绑定智能机器人），或复制链接到浏览器打开：" : "用**手机飞书**扫码授权，或复制链接到浏览器打开：",
      "",
      `🔗 ${info.url}`,
      "",
      "> 💡 首次连接请用 DSH 网页左下角「🪶 Wing」面板扫码；这里用于已连接后更换 bot。",
    ];
    if (qr) {
      lines.push("", "```", qr, "```", "");
    }
    lines.push(
      "",
      qrHint(info.expireIn),
      "",
      isWecom ? "扫码确认后，自动完成：" : "扫码确认后，bot 自动：",
      isWecom ? "- 创建并绑定智能机器人（BotID/Secret 自动写入 WING_WECOM_BOT）" : "- 创建应用 + 配置权限与事件订阅",
      "- 写入凭据 + 重启连接",
      "- 完成后通知你",
    );
    return { text: lines.join("\n") };
  },
};
