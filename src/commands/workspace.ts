/**
 * /workspace 显示/切换工作区（P1-3）
 *
 * - 无参 → 显示当前工作区（cfg.workspaceRoot ?? process.cwd()）
 * - 带参 → 校验目录存在后切换 + rotateSession 重建（新会话落到新工作区）
 */
import type { BridgeCommandDef } from "./types.js";

export const workspaceCommand: BridgeCommandDef = {
  name: "workspace",
  description: "显示/切换工作区：/workspace ｜ /workspace <路径>",
  async run(deps, rawInput, msg) {
    const services = deps.services;
    if (!services?.workspace) return { text: "⚠️ 工作区服务不可用，请稍后再试" };

    const arg = rawInput.trim();
    // 无参 → 显示当前
    if (!arg) {
      return { text: `📁 当前工作区：**${services.workspace.get()}**\n切换：\`/workspace <绝对路径>\`` };
    }

    // 带参 → 切换（校验路径存在）
    const ok = services.workspace.set(arg);
    if (!ok) return { text: `⚠️ 路径无效或不存在：\`${arg}\`\n请输入存在的绝对路径。` };

    // 切换成功 → 重建会话（新 session 落到新 cwd）
    if (services.rotateSession) {
      await services.rotateSession(msg.chatId);
      return { text: `✅ 工作区已切换为：**${arg}**\n会话已重建，后续任务在新工作区执行。` };
    }
    return { text: `✅ 工作区已切换为：**${arg}**（会话重建服务不可用，新消息生效）` };
  },
};
