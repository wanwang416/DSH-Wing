/**
 * /permission 权限详情 + 单选卡（P1-2：当前模式 + 三级说明 + 点选即切换）
 */
import type { BridgeCommandDef } from "./types.js";
import { permissionModeLabel, PERMISSION_THREE_LEVELS } from "./labels.js";
import { buildSelectorCard } from "../interactive/selector.js";

const MODE_ITEMS = [
  { id: "read-only", label: "只读", desc: "只能查看和提问，不能改文件、不能执行命令" },
  { id: "workspace-write", label: "工作区读写", desc: "可在当前项目内读写文件、执行命令（默认）" },
  { id: "danger-full-access", label: "完全访问", desc: "无限制，可执行任何操作（高风险，慎用）" },
];

export const permissionCommand: BridgeCommandDef = {
  name: "permission",
  description: "查看权限详情并切换（当前模式 + 三级说明 + 选卡）",
  async run(deps, _rawInput, _msg) {
    const runtime = deps.services?.runtime;
    if (!runtime) return { text: "⚠️ 权限服务不可用，请稍后再试" };
    const mode = runtime.getPermissionMode();
    return {
      card: buildSelectorCard({
        header: "🔐 权限模式",
        title: [
          `当前模式：**${permissionModeLabel(mode)}**`,
          "",
          "三级说明：",
          ...PERMISSION_THREE_LEVELS,
          "",
          "点按钮即切换，只对后续新消息生效。",
        ].join("\n"),
        items: MODE_ITEMS.map((it) => ({ ...it, current: it.id === mode })),
        opPrefix: "permission",
        template: "turquoise",
      }),
    };
  },
};
