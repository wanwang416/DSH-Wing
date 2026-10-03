/**
 * ★ M39（阶段6d）：per-chat 工作区覆盖持久化——/workspace 由"改全局 cfg.workspaceRoot"
 *   改为按会话生效。与 model-overrides / permission-overrides 同一套模式
 *   （照抄现成的，原子性沿用其简化写法；存路径字符串 → 重启恢复）。
 *
 * 病灶：全局单例被单会话命令改写——A 会话 /workspace 切目录，B 会话跟着变
 * （与阶段 5a 权限 per-chat 化是同一类病）。
 */

import { readFileSync, writeFileSync } from "node:fs";

export function createWorkspaceOverrideStore(file: string) {
  let overrides = new Map<string, string>();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    overrides = new Map(Object.entries(parsed));
  } catch {
    overrides = new Map();
  }

  const persist = () => {
    try {
      writeFileSync(file, JSON.stringify(Object.fromEntries(overrides), null, 2), { mode: 0o600 });
    } catch {
      // 忽略（与 model-overrides 一致）
    }
  };

  return {
    /** 该 chat 的工作区覆盖（无则 undefined → 用全局默认） */
    get(chatId: string): string | undefined {
      return overrides.get(chatId);
    },
    set(chatId: string, root: string): void {
      overrides.set(chatId, root);
      persist();
    },
    remove(chatId: string): void {
      overrides.delete(chatId);
      persist();
    },
    keys(): string[] {
      return [...overrides.keys()];
    },
  };
}

export type WorkspaceOverrideStore = ReturnType<typeof createWorkspaceOverrideStore>;
