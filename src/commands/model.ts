/**
 * /model 切换模型（P1-2 · ALAN 拍板③：per-chat override，单聊生效）
 *
 * - 无参 → 发模型单选卡（provider/模型 列表，点选即切换，无需打字）
 * - 带参 → 文本切换 `/model <provider>/<model>`（兼容既有桥接用法）
 *
 * 机制：services.modelOverride.set → modelRegistry.setOverride（persist + mutate live 对象），
 * 下条回复自动用新模型，无需重建会话（对齐成熟桥接实现 live entry）。
 */
import type { BridgeCommandDef } from "./types.js";
import { buildSelectorCard } from "../interactive/selector.js";
import { parseModelSig, formatModelSig } from "../agent/model.js";

export const modelCommand: BridgeCommandDef = {
  name: "model",
  description: "切换模型：/model（选卡）｜/model 供应商/模型",
  async run(deps, rawInput, msg) {
    const services = deps.services;
    if (!services) return { text: "⚠️ 服务未就绪，请稍后再试" };

    // 带参 → 文本切换（无参才发卡）
    const arg = rawInput.trim();
    if (arg) {
      const ov = services.modelOverride;
      if (!ov) return { text: "⚠️ 模型服务不可用，请稍后再试" };
      const sel = parseModelSig(arg);
      if (!sel) {
        return { text: "⚠️ 格式应为「供应商/模型」（如 deepseek/deepseek-chat）\n用法：/model 或 /model <provider>/<model>" };
      }
      ov.set(msg.chatId, sel);
      return {
        text: `🔄 本会话模型已切换为 **${sel.provider}/${sel.model}**\n下条回复生效，其他会话不受影响。`,
      };
    }

    // 无参 → 模型单选卡
    try {
      const [options, cur] = await Promise.all([
        services.getModelOptions?.() ?? Promise.resolve([]),
        services.getModel?.(),
      ]);
      if (options.length === 0) {
        return { text: `当前模型：${cur ? `${cur.provider}/${cur.model}` : "未知"}\n（模型列表暂不可用，可手动 /model <provider>/<model>）` };
      }
      const currentSig = formatModelSig(cur);
      const items = options.map((it) => ({
        ...it,
        // 当前选中项置灰（✓）
        current: Boolean(currentSig && it.id === currentSig),
      }));
      const override = services.modelOverride?.has?.(msg.chatId);
      return {
        card: buildSelectorCard({
          header: "🤖 切换模型",
          title: override
            ? `当前 **${currentSig || "未知"}**（本会话已手动指定）\n点按钮切换，仅本会话生效。`
            : `当前 **${currentSig || "未知"}**\n点按钮切换，仅本会话生效。`,
          items,
          opPrefix: "model",
        }),
      };
    } catch (err) {
      return { text: `⚠️ 构建模型列表失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
