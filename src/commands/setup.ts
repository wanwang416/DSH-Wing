/**
 * /setup 占位（P1-3）
 *
 * M4.2 扫码绑定完善（会议邀请/文档评论等扩展）。当前回执已启用能力清单。
 */
import type { BridgeCommandDef } from "./types.js";

export const setupCommand: BridgeCommandDef = {
  name: "setup",
  description: "查看已启用能力：/setup（M4.2 扫码绑定完善）",
  async run() {
    return {
      text:
        "🔧 **dsh-wing 能力清单**\n\n" +
        "✅ 已启用：\n" +
        "- 飞书桥（群聊 / P2P 私聊）\n" +
        "- 命令系统：/mode /permission /model /preset /new /stop /status /help\n" +
        "- 危险操作审批卡（仅老板本人可点）\n" +
        "- 模型 / preset 切换（GUI 同步）\n" +
        "- 意图桥（群聊闲聊自动过滤）\n\n" +
        "🚧 规划中（M4.2）：扫码绑定、会议邀请、文档评论。",
    };
  },
};
