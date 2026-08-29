/**
 * /new 开启全新会话（对齐基底成熟桥接 rotate）
 *
 * 基底机制：rotate 必须 mint 全新 session id（fresh runNonce + generation 0），
 * 不能只 bump generation——`:gen+1` 会撞旧 runNonce 家族的持久化日志，DSH 首轮
 * 报 "already persisted at a different cwd (id collision)" → /new 后无回复。
 * 完整 rotate 由 index.ts 的 rotateSession 提供（本命令只调用，不持有运行时状态）。
 */
import type { BridgeCommandDef } from "./types.js";

export const newCommand: BridgeCommandDef = {
  name: "new",
  description: "开启一个全新会话（旧会话保留在 DSH 列表）",
  async run(deps, _rawInput, msg) {
    const rotate = deps.services?.rotateSession;
    if (!rotate) {
      return { text: "⚠️ 开启新会话的服务不可用，请稍后再试" };
    }
    await rotate(msg.chatId);
    return { text: "已开启全新会话 🆕（旧会话保留在 DSH 列表，可随时到 GUI 查看）" };
  },
};
