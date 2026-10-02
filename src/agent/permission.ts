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
    // ★ M40（阶段5）：宿主 resolve 对未知名抛错会被这里接住——warn 必须写明「未生效」+ preset 名，
    //   让链路可核对（caller 层 /mode 回执不得谎报「已切换」）。read-only 等三档在 dsh-base
    //   patch（@deepseek-ai/dsh-permission-presets 默认表）已内置，正常部署不会走到本分支。
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`权限设置失败（未生效，维持默认权限）：请求 preset=${mode}，宿主返回：${detail}`);
    return false;
  }
}
