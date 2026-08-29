/**
 * /mode <mode> 切换权限模式（P1-2：无参发单选卡；★ 只对新消息生效，当前运行 agent 不变更）
 *
 * 合法模式：read-only / workspace-write / danger-full-access（PermissionMode 三选一）
 * - 无参 → 权限单选卡（点选即切换）
 * - 带合法参数 → 文本切换（兼容旧用法）
 * - 非法参数 → 提示
 */
import type { BridgeCommandDef } from "./types.js";
import { permissionModeLabel, PERMISSION_THREE_LEVELS } from "./labels.js";
import { buildSelectorCard } from "../interactive/selector.js";

const VALID_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

const MODE_ITEMS = [
  { id: "read-only", label: "只读", desc: "只能查看和提问，不能改文件、不能执行命令" },
  { id: "workspace-write", label: "工作区读写", desc: "可在当前项目内读写文件、执行命令（默认）" },
  { id: "danger-full-access", label: "完全访问", desc: "无限制，可执行任何操作（高风险，慎用）" },
];

export const modeCommand: BridgeCommandDef = {
  name: "mode",
  description: "切换权限模式：/mode（选卡）｜/mode read-only｜workspace-write｜danger-full-access",
  async run(deps, rawInput, _msg) {
    const runtime = deps.services?.runtime;
    if (!runtime) return { text: "⚠️ 权限服务不可用，请稍后再试" };

    const arg = rawInput.trim().toLowerCase();
    // 带参数 → 文本切换（保持兼容）
    if (arg) {
      // 参数非法 → 提示（不吞）
      if (!(VALID_MODES as readonly string[]).includes(arg)) {
        return {
          text: `⚠️ 未知模式「${rawInput.trim()}」\n可用模式：read-only｜workspace-write｜danger-full-access`,
        };
      }
      // 设置成功 → 注明只对新消息生效
      const ok = runtime.setPermissionMode(arg);
      if (!ok) return { text: "⚠️ 权限模式更新失败，请稍后再试" };
      return {
        text: `权限模式已切换为「${permissionModeLabel(arg)}」\n📌 只对后续新消息生效，当前正在进行的任务不受影响。`,
      };
    }

    // 无参数 → 权限单选卡（当前项置灰 ✓）
    const cur = runtime.getPermissionMode();
    return {
      card: buildSelectorCard({
        header: "🔐 切换权限模式",
        title: `当前模式：**${permissionModeLabel(cur)}**\n${PERMISSION_THREE_LEVELS[0]}\n${PERMISSION_THREE_LEVELS[1]}\n${PERMISSION_THREE_LEVELS[2]}\n点按钮即切换，只对后续新消息生效。`,
        items: MODE_ITEMS.map((it) => ({ ...it, current: it.id === cur })),
        opPrefix: "mode",
        template: "turquoise",
      }),
    };
  },
};
