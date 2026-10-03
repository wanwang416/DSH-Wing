/**
 * 权限分级（默认保守）
 *
 * read-only / workspace-write / danger-full-access 三级。
 * ★ 默认 workspace-write（成熟桥接实现 默认 danger-full-access，我们反着来）。
 *
 * 参考成熟桥接实现：
 * permissionPresets.apply(session, mode, cb) + approval.setPolicy(agent, policy)。
 *
 * ★ M26（阶段6d）：apply 失败/服务不可用时 **fail-closed 降级**——旧实现只 warn 后跳过，
 *   权限停留在原值；若原值宽松（danger-full-access），等于"想收紧却没收紧"还继续跑。
 *   新语义：拿不到服务或 apply 抛错 → 显式落 read-only（最保守档）+ warn「降级」；
 *   正常 apply 语义不变。
 */

import type { PermissionMode } from "../config/defaults.js";

export interface PermissionAgentLike {
  session?: unknown;
}

/** 最保守档（fail-closed 降级目标） */
const FALLBACK_MODE: PermissionMode = "read-only";

export function applyPermission(
  ctx: any,
  agent: PermissionAgentLike,
  mode: PermissionMode,
  logger?: { info?: (m: string) => void; warn?: (m: string) => void },
): boolean {
  try {
    const permission = ctx.get?.("permissionPresets");
    const approval = ctx.get?.("approval");
    if (permission?.apply && agent.session && mode) {
      permission.apply(agent.session, mode, (policy: unknown) => {
        approval?.setPolicy?.(agent, policy);
      });
      logger?.info?.(`权限已设为 ${mode}（session-scoped）`);
      return true;
    }
    // ★ M26：服务不可用 ≠ 静默保留原值——显式降级 read-only + approval 策略同步收紧
    logger?.warn?.(`permissionPresets 服务不可用，权限降级为 ${FALLBACK_MODE}（请求 preset=${mode} 未生效；fail-closed，不保留宽松态）`);
    approval?.setPolicy?.(agent, { mode: FALLBACK_MODE });
    return false;
  } catch (err) {
    // ★ M40（阶段5）+ M26（阶段6d）：apply 抛错同样降级——warn 写明「未生效+降级」+ preset 名，
    //   让链路可核对（caller 层 /mode 回执不得谎报「已切换」）。
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`权限设置失败（请求 preset=${mode} 未生效，宿主返回：${detail}）→ 降级为 ${FALLBACK_MODE}（fail-closed）`);
    try {
      const approval = ctx.get?.("approval");
      approval?.setPolicy?.(agent, { mode: FALLBACK_MODE });
    } catch {
      // approval 也不可用——已在 warn 留痕，不能再抛（caller 层按返回 false 处理）
    }
    return false;
  }
}
