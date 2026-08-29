/**
 * /preset 切换 agent 预设（P1-2 · ALAN 拍板①：真实 roster + 兜底 4 档）
 *
 * - 无参 → 发预设单选卡（真实 list 或兜底 4 档，点选即切换）
 * - 带参 → 文本切换 `/preset <id>`
 *
 * 切换语义（ALAN 拍板②）：/mode 保留权限语义，preset 用独立 /preset 命令。
 * 换预设 = 开新会话（rotateSession），下一条消息按新预设执行（对齐 /new rotate 防 session id 冲突）。
 */
import type { BridgeCommandDef } from "./types.js";
import { buildSelectorCard } from "../interactive/selector.js";

export const presetCommand: BridgeCommandDef = {
  name: "preset",
  description: "切换会话预设：/preset（选卡）｜/preset <id>",
  async run(deps, rawInput, msg) {
    const services = deps.services;
    if (!services?.runtime) return { text: "⚠️ 服务未就绪，请稍后再试" };

    // 带参 → 文本切换
    const arg = rawInput.trim();
    if (arg) {
      const cur = services.runtime.getAgentPreset();
      if (arg === cur) return { text: `当前已是「${arg}」预设，无需切换` };
      services.runtime.setAgentPreset(arg);
      if (services.rotateSession) await services.rotateSession(msg.chatId).catch(() => void 0);
      return { text: `🧩 会话预设已切换为「${arg}」，已开新会话\n下一条消息按新预设执行。` };
    }

    // 无参 → 预设单选卡
    try {
      const presets = (await services.listPresets?.()) ?? [];
      if (presets.length === 0) return { text: "⚠️ 预设列表不可用" };
      const cur = services.runtime.getAgentPreset();
      const items = presets.map((p) => ({
        id: p.id,
        label: p.label,
        desc: p.desc,
        broken: p.broken,
        current: p.id === cur,
      }));
      return {
        card: buildSelectorCard({
          header: "🧩 切换会话预设",
          title: `当前预设：**${presets.find((p) => p.id === cur)?.label ?? cur}**\n点按钮切换（会开新会话），下一条消息生效。`,
          items,
          opPrefix: "preset",
        }),
      };
    } catch (err) {
      return { text: `⚠️ 构建预设列表失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
