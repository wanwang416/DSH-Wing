/**
 * /resume 恢复上次会话（P1-3）
 *
 * 现有机制：任何消息 → getOrCreateAgent → 有 route.sessionId 自动 resumeAgent。
 * /resume 是显式触发 + 状态回执：告诉用户当前恢复的是哪个 session / 有无历史会话。
 */
import type { BridgeCommandDef } from "./types.js";

export const resumeCommand: BridgeCommandDef = {
  name: "resume",
  description: "恢复上次会话：/resume",
  async run(deps, _rawInput, msg) {
    const services = deps.services;
    if (!services?.resumeSession) return { text: "⚠️ 会话服务不可用，请稍后再试" };

    const { resumed, sessionId } = await services.resumeSession(msg.chatId);
    if (!resumed) {
      return { text: "ℹ️ 没有可恢复的历史会话（本会话将全新开始）" };
    }
    return { text: `✅ 已恢复上次会话\nsession：${sessionId ?? "?"}\n上下文已接续，直接说需求即可。` };
  },
};
