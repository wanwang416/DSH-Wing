/**
 * ★ G10（阶段6a）：启动 in-flight 互斥。
 *
 * 问题：startBridge 无"正在启动中"互斥，短时间两次调用（热重载/事件重入/手动触发）
 * 会跑出两条并行初始化管线（同一条消息被处理两次）。
 *
 * 语义：
 *  - 并发调用共享同一个 promise（底层只执行一次）；
 *  - 完成/失败都清空 in-flight——失败不清 = 后续永远拿不到启动机会（永久卡死）；
 *  - 串行调用每次都真实执行（幂等门闩 lifecycleStarted 在 startBridge 内部另管，这里只管互斥）。
 */
export function createStartMutex(start: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await start();
      } finally {
        inflight = undefined; // 成功/失败都清——防永久卡死
      }
    })();
    return inflight;
  };
}
