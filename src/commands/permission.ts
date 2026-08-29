/**
 * /permission 权限详情（当前模式 + 三级说明，全中文，铁律 12）
 */
import type { BridgeCommandDef } from "./types.js";
import { permissionModeLabel, PERMISSION_THREE_LEVELS } from "./labels.js";

export const permissionCommand: BridgeCommandDef = {
  name: "permission",
  description: "查看权限模式详情（当前模式 + 三级说明）",
  async run(deps, _rawInput, _msg) {
    const mode = deps.services?.runtime?.getPermissionMode?.() ?? "未知";
    return {
      text: [
        `🔐 当前权限模式：${permissionModeLabel(mode)}`,
        "",
        "三级说明：",
        ...PERMISSION_THREE_LEVELS,
        "",
        "切换：/mode read-only｜workspace-write｜danger-full-access",
      ].join("\n"),
    };
  },
};
