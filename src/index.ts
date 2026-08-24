import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * dsh-wing — DSH 飞书原生插件（M0 脚手架空壳）
 *
 * 只验证插件能被 DSH 加载，不启动任何飞书连接。
 * M0 阶段 cordis.patch.yml 默认 enabled: false。
 */

export const name = "dsh-feishu-bridge";

export const inject: string[] = [];

export function stateDir(): string {
  // M1 起返回 <DSH_HOME>/feishu-bridge
  return "";
}

export function apply(ctx: any, rawConfig: unknown): void {
  ctx.logger?.info?.("[dsh-feishu-bridge] plugin loaded");
  // M0 加载验证 marker：DSH 能加载并调用 apply 时写入，便于日志不可读时取证
  try {
    const home = process.env.DSH_HOME ?? "本地目录";
    writeFileSync(join(home, ".dsh-wing-loaded"), `loaded at ${new Date().toISOString()}\n`, { mode: 384 });
  } catch {
    // 非 DSH 环境（如单测）忽略
  }
}
