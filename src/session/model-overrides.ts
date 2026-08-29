/**
 * P1-2 per-chat 模型覆盖持久化（/model 手动切换，ALAN 拍板③：单聊生效，GUI 不冲手动设置）
 *
 * 存 "provider/model" 字符串 → 重启恢复。与 routes.json 独立（不动现有路由结构，避免回归）。
 */

import { readFileSync, writeFileSync } from "node:fs";

/** "provider/model" 归一化签名（parseModelSig 用） */
export function createModelOverrideStore(file: string) {
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
      // 忽略
    }
  };

  return {
    /** 该 chat 的手动覆盖签名（无则 undefined） */
    get(chatId: string): string | undefined {
      return overrides.get(chatId);
    },
    set(chatId: string, sig: string): void {
      overrides.set(chatId, sig);
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

export type ModelOverrideStore = ReturnType<typeof createModelOverrideStore>;
