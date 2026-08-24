/**
 * per-chat 串行锁：同一 chatId 的消息排队处理，不同 chatId 并行。
 *
 * 参考 成熟桥接实现 adapter.py _chat_locks（OrderedDict + Lock）：
 * TypeScript 用 Map<string, Promise> 链式串行。
 */

export function createSerialQueue() {
  const tails = new Map<string, Promise<unknown>>();

  /** 串行执行：同一 key 的 task 排队，前一个完成后才跑下一个 */
  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    // 吞掉错误防止链断裂；调用方拿到的 next 仍会 reject
    tails.set(key, next.catch(() => void 0));
    return next;
  }

  function size(): number {
    return tails.size;
  }

  function clear(): void {
    tails.clear();
  }

  return { enqueue, size, clear };
}

export type SerialQueue = ReturnType<typeof createSerialQueue>;
