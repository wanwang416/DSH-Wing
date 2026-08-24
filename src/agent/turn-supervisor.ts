/**
 * 轮次监督器（600s 超时）
 *
 * 参考成熟桥接实现：
 * - arm(key)：turn/start 与 tool/call 时调用
 * - disarm(key)：assistant/message 时调用
 * - 超时 → 回调 onTimeout（index.ts 里 dispose agent 解锁）
 */

export interface TurnSupervisorDeps {
  timeoutMs: number;
  onTimeout(key: string): void;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  now?: () => number;
}

export function createTurnSupervisor(deps: TurnSupervisorDeps) {
  const now = deps.now ?? Date.now;
  const armed = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    arm(key: string): void {
      armed.set(key, now());
    },
    disarm(key: string): void {
      armed.delete(key);
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        const cutoff = now() - deps.timeoutMs;
        for (const [key, armedAt] of armed) {
          if (armedAt < cutoff) {
            armed.delete(key);
            deps.logger?.warn?.(`轮次超时（${deps.timeoutMs}ms）: ${key}，将 dispose agent 解锁`);
            try {
              deps.onTimeout(key);
            } catch {
              // 忽略
            }
          }
        }
      }, 1_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      armed.clear();
    },
  };
}

export type TurnSupervisor = ReturnType<typeof createTurnSupervisor>;
