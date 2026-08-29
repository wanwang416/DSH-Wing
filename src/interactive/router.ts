/**
 * P1-2 交互卡回调路由器（单选卡点选 → 切换 + 回执）
 *
 * event-handler.ts card.action.trigger 把非 answer:/free_text: 的 op 交给本路由：
 *   mode:xxx / permission:xxx  → 权限切换（/mode /permission 单选卡）
 *   model:provider/model       → 本会话模型切换（/model 单选卡，单聊生效——拍板③）
 *   preset:xxx                 → agent 预设切换 + 开新会话（/preset 单选卡）
 *   approval:xxx               → P1-1 审批卡（预留，P1-1 实现）
 *
 * ★ 所有回执经 reply（outbox text），dedupeKey 由 index.ts 注入带唯一 token（卡片 messageId），
 *   同一张卡点两次不被去重吞（成熟桥接踩坑）。
 */

import { parseOp } from "./selector.js";
import { permissionModeLabel } from "../commands/labels.js";
import { presetLabel, type PresetOption } from "../agent/preset.js";
import { parseModelSig, formatModelSig, type ModelRegistry } from "../agent/model.js";

export interface InteractiveRouterDeps {
  runtime: {
    getPermissionMode(): string;
    setPermissionMode(mode: string): boolean;
    getAgentPreset(): string;
    setAgentPreset(id: string): void;
  };
  modelRegistry: Pick<ModelRegistry, "setOverride" | "clearOverride" | "hasOverride" | "liveFor" | "getModelDefault">;
  /** 开新会话（preset 切换用：对齐 /new rotate 语义，防 session id 冲突） */
  rotateSession?(chatId: string): Promise<void>;
  /** 回执（outbox text，index.ts 提供） */
  reply(chatId: string, text: string): unknown;
  /** preset 中文名查询（preset 单选卡回执用；函数形式 → 跟随 listPresets 异步更新后的真实 roster） */
  presets?: () => readonly PresetOption[];
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
}

export function createInteractiveRouter(deps: InteractiveRouterDeps) {
  /** 权限切换（/mode /permission 单选卡共用） */
  function switchPermission(chatId: string, arg: string): boolean {
    const ok = deps.runtime.setPermissionMode(arg);
    if (!ok) {
      deps.reply(chatId, `⚠️ 未知权限模式「${arg}」`);
      return true;
    }
    deps.reply(
      chatId,
      `🔐 权限模式已切换为「${permissionModeLabel(arg)}」\n📌 只对后续新消息生效，当前任务不受影响。`,
    );
    return true;
  }

  /** 模型切换（/model 单选卡：per-chat override，单聊生效——拍板③） */
  function switchModel(chatId: string, arg: string): boolean {
    const sel = parseModelSig(arg);
    if (!sel) {
      deps.reply(chatId, `⚠️ 模型格式应为「供应商/模型」（如 deepseek/deepseek-chat）`);
      return true;
    }
    deps.modelRegistry.setOverride(chatId, sel);
    deps.reply(chatId, `🔄 本会话模型已切换为 **${sel.provider}/${sel.model}**\n下条回复生效，其他会话不受影响。`);
    return true;
  }

  /** 预设切换（/preset 单选卡：换预设 = 开新会话） */
  async function switchPreset(chatId: string, arg: string): Promise<boolean> {
    deps.runtime.setAgentPreset(arg);
    if (deps.rotateSession) {
      await deps.rotateSession(chatId).catch(() => void 0);
    }
    const label = presetLabel(arg, deps.presets?.() ?? []);
    deps.reply(chatId, `🧩 会话预设已切换为「${label}」，已开新会话\n下一条消息按新预设执行。`);
    return true;
  }

  return {
    /**
     * 单选卡回调分发。@returns true=已消费（event-handler 不再处理）
     * op 前缀不匹配 → false（保留未知前缀日志）
     */
    async onCardAction(chatId: string, op: string): Promise<boolean> {
      const { cmd, arg } = parseOp(op);
      switch (cmd) {
        case "mode":
        case "permission":
          return switchPermission(chatId, arg);
        case "model":
          return switchModel(chatId, arg);
        case "preset":
          return await switchPreset(chatId, arg);
        default:
          deps.logger?.warn?.(`interactive router: 未知操作前缀 cmd=${cmd}`);
          return false;
      }
    },
  };
}

export type InteractiveRouter = ReturnType<typeof createInteractiveRouter>;

/** 便捷：模型显示名（live 对象 → "provider/model"） */
export { formatModelSig };
