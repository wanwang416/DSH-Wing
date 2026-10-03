/**
 * per-chat 串行锁：同一 chatId 的消息排队处理，不同 chatId 并行。
 *
 * 参考 成熟桥接实现 adapter.py _chat_locks（OrderedDict + Lock）：
 * TypeScript 用 Map<string, Promise> 链式串行。
 *
 * ★ M28（阶段6b）：队列任务超时——一条任务永久挂起（网络无响应/SDK 不回调）不再堵死整条队列。
 *   超时任务标记失败（reject + warn 回调 + 计数），队列继续。
 */

export interface EnqueueOptions {
  /** 任务超时（ms）；undefined = 不超时（保持旧行为，供无超时调用点使用） */
  timeoutMs?: number;
  /** 超时回调（日志/计数用；不许静默丢弃） */
  onTimeout?: (message: string) => void;
}

export function createSerialQueue() {
  const tails = new Map<string, Promise<unknown>>();

  /** 串行执行：同一 key 的 task 排队，前一个完成后才跑下一个 */
  function enqueue<T>(key: string, task: () => Promise<T>, opts?: EnqueueOptions): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = (): Promise<T> =>
      opts?.timeoutMs === undefined ? task() : withTimeout(key, task, opts.timeoutMs, opts.onTimeout);
    const next = prev.then(run, run);
    // 吞掉错误防止链断裂；调用方拿到的 next 仍会 reject
    tails.set(key, next.catch(() => void 0));
    return next;
  }

  /** M28：给单条任务套超时外壳；超时后 reject 但任务本体继续在后台跑（无法强杀 promise） */
  function withTimeout<T>(key: string, task: () => Promise<T>, timeoutMs: number, onTimeout?: (m: string) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const msg = `serial queue: 任务超时（key=${key}, ${timeoutMs}ms），已释放队列让后续任务继续`;
        onTimeout?.(msg);
        reject(new Error(msg));
      }, timeoutMs);
      timer.unref?.(); // unref：任务挂起、超时未到期间，不阻止宿主进程退出（6b 验收返工：恢复，不为迁就测试改实现）
      task().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
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
