/**
 * /workspace 显示/切换工作区（P1-3；★ M39 阶段6d 改 per-chat）
 *
 * - 无参 → 显示**本会话**当前工作区（会话 override 优先 → 全局默认）
 * - 带参 → 校验目录存在后切换 + rotateSession 重建（新会话落到新工作区）
 * - ★ M39：切换只写本会话的 override（workspace-overrides.json 落盘），
 *   **仅本会话生效**——不再改全局 cfg.workspaceRoot（A 会话切换不影响 B 会话）。
 */
import type { BridgeCommandDef } from "./types.js";

export const workspaceCommand: BridgeCommandDef = {
  name: "workspace",
  description: "显示/切换本会话工作区：/workspace ｜ /workspace <路径>",
  async run(deps, rawInput, msg) {
    const services = deps.services;
    if (!services?.workspace) return { text: "⚠️ 工作区服务不可用，请稍后再试" };

    const chatId = msg.chatId;
    const arg = rawInput.trim();
    // 无参 → 显示当前（本会话）
    if (!arg) {
      return {
        text: `📁 当前会话工作区：**${services.workspace.get(chatId)}**\n切换（仅本会话生效）：\`/workspace <绝对路径>\``,
      };
    }

    // 带参 → 切换（校验路径存在；只写本会话 override）
    const ok = services.workspace.set(chatId, arg);
    if (!ok) return { text: `⚠️ 路径无效或不存在：\`${arg}\`\n请输入存在的绝对路径。` };

    // 切换成功 → 重建会话（新 session 落到新 cwd）
    if (services.rotateSession) {
      await services.rotateSession(msg.chatId);
      return {
        text: `✅ 本会话工作区已切换为：**${arg}**\n（仅本会话生效，其他会话不受影响；会话已重建，后续任务在新工作区执行。）`,
      };
    }
    return {
      text: `✅ 本会话工作区已切换为：**${arg}**（仅本会话生效；会话重建服务不可用，新消息生效）`,
    };
  },
};
