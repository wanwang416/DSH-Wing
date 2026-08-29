/**
 * /steer 手动注入消息（P1-3）
 *
 * 用途：任务进行中，用户想用文字直接注入给 agent（不依赖自然插话分类）。
 * - running → agent.steer（next-step 边界温和打断）
 * - idle → agent.followup（排队下一轮）
 * - 无 agent → no-agent（提示先发条消息建立会话）
 */
import type { BridgeCommandDef } from "./types.js";

export const steerCommand: BridgeCommandDef = {
  name: "steer",
  description: "手动注入消息给 agent：/steer <文本>",
  async run(deps, rawInput, msg) {
    const services = deps.services;
    const arg = rawInput.trim();
    if (!arg) return { text: "📌 用法：`/steer <文本>`\n将文本直接注入 agent（进行中任务可打断改向）。" };
    if (!services?.steer) return { text: "⚠️ 注入服务不可用，请稍后再试" };

    const action = await services.steer(msg.chatId, arg);
    switch (action) {
      case "steered":
        return { text: `↪️ 已注入（打断生效）：${arg.slice(0, 60)}` };
      case "queued":
        return { text: `📥 已注入（排队下轮）：${arg.slice(0, 60)}` };
      default:
        return { text: "ℹ️ 当前无进行中的会话，请先发一条普通消息建立会话。" };
    }
  },
};
