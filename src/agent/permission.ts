/**
 * 权限分级（默认保守）
 *
 * read-only / workspace-write / danger-full-access 三级。
 * ★ 默认 workspace-write（成熟桥接实现 默认 danger-full-access，我们反着来）。
 *
 * 参考成熟桥接实现：
 * permissionPresets.apply(session, mode, cb) + approval.setPolicy(agent, policy)。
 */

import type { PermissionMode } from "../config/defaults.js";

export interface PermissionAgentLike {
  session?: unknown;
}

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
    logger?.warn?.("permissionPresets 服务不可用，跳过权限设置（M1 默认保守由配置保证）");
    return false;
  } catch (err) {
    logger?.warn?.(`权限设置失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
