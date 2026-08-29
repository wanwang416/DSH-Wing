/**
 * /status 当前运行状态（连接/消息队列/会话数/模型/权限，全中文，铁律 12）
 */
import type { BridgeCommandDef } from "./types.js";
import { connStateLabel, permissionModeShort } from "./labels.js";

export const statusCommand: BridgeCommandDef = {
  name: "status",
  description: "查看当前运行状态（连接、消息队列、会话数、模型、权限）",
  async run(deps, _rawInput, _msg) {
    const svc = deps.services;
    const conn = connStateLabel(svc?.connection?.state?.() ?? "unknown");
    const pendingOut = svc?.outbox?.pendingCount?.() ?? 0;
    const pendingIn = svc?.inboundWal?.pendingCount?.() ?? 0;
    const sessions = svc?.mapper?.size?.() ?? 0;
    const mode = permissionModeShort(svc?.runtime?.getPermissionMode?.() ?? "未知");
    const preset = svc?.runtime?.getAgentPreset?.() ?? "未知";
    const model = await svc?.getModel?.();
    const modelText = model?.provider && model.model ? `${model.model}（${model.provider}）` : "未配置";

    return {
      text: [
        "📊 当前运行状态",
        `· 连接：${conn}`,
        `· 待发送：${pendingOut} 条`,
        `· 待消化入站：${pendingIn} 条`,
        `· 活跃会话：${sessions} 个`,
        `· 模型：${modelText}`,
        `· 权限模式：${mode}`,
        `· 会话预设：${preset}`,
      ].join("\n"),
    };
  },
};
