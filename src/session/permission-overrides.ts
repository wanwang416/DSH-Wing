/**
 * ★ 阶段 5 X5（2026-10-02）：per-chat 权限模式存储
 *
 * 照抄 model-overrides.ts 模式（JSON 落盘、重启恢复），补充：
 *  - persist 改 tmp + rename 原子写（对齐阶段 4 dedup.ts 教训，不重复其"非原子"坑）
 *  - 解析失败：改名保留 .bak + warn，从空开始（可用性优先；权限只是 UI 偏好，非凭证）
 *
 * 消费语义（ALAN 拍板）：
 *  - 降级/常规调整（read-only / workspace-write）→ 任何人可改**自己所在会话**
 *  - 升到 danger-full-access → 只有老板可以（且身份取不到必须拒绝，fail-closed）
 *  - 各会话落盘保留（重启后仍在），与 /model 行为一致
 *  - 未设置过的会话用配置默认值（不做历史会话一次性初始化）
 */

import { existsSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import type { PermissionMode } from "../config/defaults.js";

export function createPermissionOverrideStore(file: string) {
  let overrides = new Map<string, PermissionMode>();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, PermissionMode>;
    // 只接受三个合法值；非法值丢弃（防手改文件注入任意字符串进 applyPermission）
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "read-only" || v === "workspace-write" || v === "danger-full-access") {
        overrides.set(k, v);
      }
    }
  } catch {
    // ★ M14 同款教训：文件存在但解析失败 → 保留 .bak（不许静默清空丢历史偏好）
    if (existsSync(file)) {
      try {
        rmSync(`${file}.bak`, { force: true });
        renameSync(file, `${file}.bak`);
      } catch {
        /* 备份失败也继续（下次 persist 会覆盖写） */
      }
    }
    overrides = new Map();
  }

  const persist = (): void => {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(overrides), null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // 写失败保留原文件（下个 set 重试）；权限偏好丢失无害（回退配置默认值）
    }
  };

  return {
    /** 该 chat 的权限覆盖（无则 undefined → 用配置默认值） */
    get(chatId: string): PermissionMode | undefined {
      return overrides.get(chatId);
    },
    set(chatId: string, mode: PermissionMode): void {
      overrides.set(chatId, mode);
      persist();
    },
    /** 该 chat 是否设置过 */
    has(chatId: string): boolean {
      return overrides.has(chatId);
    },
    remove(chatId: string): void {
      if (overrides.delete(chatId)) persist();
    },
    /** 解析该会话实际生效的权限（override ?? 默认值） */
    resolveFor(chatId: string, fallback: PermissionMode): PermissionMode {
      return overrides.get(chatId) ?? fallback;
    },
  };
}

export type PermissionOverrideStore = ReturnType<typeof createPermissionOverrideStore>;

/**
 * ★ X5 共用身份判定（命令层与卡片回调同一份，不许各写各的）：
 *  - 降级/常规 ≤ workspace-write → 放行（只对本会话生效，危害可控）
 *  - danger-full-access → 校验老板身份；任一取不到/未配置 → 拒绝（fail-closed）
 *
 * @returns null = 放行；string = 拒绝的人话提示
 */
export function checkPermissionChange(opts: {
  target: PermissionMode;
  /** 请求者平台身份：飞书 openId / 企微 userid */
  operatorId?: string;
  /** 飞书老板 open_id */
  bossOpenId?: string;
  /** 企微老板 userid */
  wecomBossUserId?: string;
}): string | null {
  if (opts.target !== "danger-full-access") return null; // 降级/常规：任何人可改本会话
  // 提权 → fail-closed：身份缺失/未配置一律拒绝
  if (!opts.operatorId) return "无法确认操作者身份，完全访问是老板专属权限，已拒绝。";
  const isBoss = opts.operatorId === opts.bossOpenId || opts.operatorId === opts.wecomBossUserId;
  if (!isBoss) return "完全访问是老板专属权限，仅老板本人可开启。";
  return null;
}
