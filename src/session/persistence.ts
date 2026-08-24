/**
 * routes.json 持久化：chatId ↔ sessionId 映射（重启恢复）
 *
 * 参考成熟桥接实现。
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface Route {
  sessionKey: string;
  chatId: string;
  chatType: "p2p" | "group";
  sessionId: string;
  lastMessageId?: string;
  updatedAt: number;
}

export function createRouteStore(file: string, now: () => number = Date.now) {
  let routes = new Map<string, Route>();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Route[];
    routes = new Map(parsed.map((r) => [r.sessionKey, r]));
  } catch {
    routes = new Map();
  }

  const persist = () => {
    try {
      writeFileSync(file, JSON.stringify([...routes.values()], null, 2), { mode: 0o600 });
    } catch {
      // 忽略
    }
  };

  return {
    get(sessionKey: string): Route | undefined {
      return routes.get(sessionKey);
    },
    all(): Route[] {
      return [...routes.values()];
    },
    upsert(route: Route): void {
      routes.set(route.sessionKey, route);
      persist();
    },
    touch(sessionKey: string, lastMessageId?: string): void {
      const r = routes.get(sessionKey);
      if (!r) return;
      r.updatedAt = now();
      if (lastMessageId !== undefined) r.lastMessageId = lastMessageId;
      persist();
    },
    remove(sessionKey: string): void {
      routes.delete(sessionKey);
      persist();
    },
    persist,
  };
}

export type RouteStore = ReturnType<typeof createRouteStore>;
