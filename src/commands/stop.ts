/**
 * /stop 立即停止当前任务（对齐 experience 停止词 cancel 语义）
 *
 * P0-2 命令路由已保证 /stop 走命令分支（先于四类分类），不会被子分类器误判。
 */
import type { BridgeCommandDef } from "./types.js";

export const stopCommand: BridgeCommandDef = {
  name: "stop",
  description: "立即停止当前正在进行的任务",
  async run(deps, _rawInput, msg) {
    const handle = deps.services?.mapper?.get(msg.chatId);
    if (handle) {
      handle.cancel({ kind: "user" });
      return { text: "已停止当前任务 ⏹" };
    }
    return { text: "当前没有正在进行的任务" };
  },
};
