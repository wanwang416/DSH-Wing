/**
 * /help 命令帮助（遍历 bridgeCommands 注册表 + DSH 原生命命令提示）
 *
 * 注册制天然支持：listCommands 由 index.ts 从 bridgeCommands Map 汇总。
 */
import type { BridgeCommandDef } from "./types.js";

export const helpCommand: BridgeCommandDef = {
  name: "help",
  description: "查看可用命令列表",
  async run(deps, _rawInput, _msg) {
    const list = deps.services?.listCommands?.() ?? [];
    if (list.length === 0) {
      return { text: "当前没有可用命令。DSH 原生命令（如 /goal、/compact）可直接使用。" };
    }
    return {
      text: [
        "📚 可用命令",
        ...list.map((c) => `· /${c.name} — ${c.description}`),
        "",
        "DSH 原生命令（如 /goal、/compact）也可直接发送。",
      ].join("\n"),
    };
  },
};
