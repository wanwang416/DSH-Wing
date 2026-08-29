/**
 * /mode <mode> 切换权限模式（★ 只对新消息生效，当前运行 agent 不变更——拍板：避免中途改权限安全漏洞）
 *
 * 合法模式：read-only / workspace-write / danger-full-access（PermissionMode 三选一）
 */
import type { BridgeCommandDef } from "./types.js";
import { permissionModeLabel } from "./labels.js";

const VALID_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export const modeCommand: BridgeCommandDef = {
  name: "mode",
  description: "切换权限模式：/mode read-only ｜ workspace-write ｜ danger-full-access",
  async run(deps, rawInput, _msg) {
    const runtime = deps.services?.runtime;
    if (!runtime) return { text: "⚠️ 权限服务不可用，请稍后再试" };

    const arg = rawInput.trim().toLowerCase();
    // 无参数 → 显示当前模式
    if (!arg) {
      return {
        text: `当前权限模式：${permissionModeLabel(runtime.getPermissionMode())}\n\n可用模式：/mode read-only｜workspace-write｜danger-full-access`,
      };
    }
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
  },
};
