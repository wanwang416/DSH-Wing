/**
 * ★ M32（阶段6a）：凭据晚到自动恢复。
 *
 * 问题：凭据缺失时 startBlocker 置位后无任何重试——用户随后在 DSH 凭据系统写好
 * WING_LARK_APP，也必须重启宿主才能恢复（"凭据晚到"变永久失败）。
 *
 * 机制（方案 (a) 定时重试；DSH credentials 服务无变更事件接口，(b) 不可行——实测确认）：
 *  - 按 intervalMs 轮询 describeBlocker()：返回 undefined = 凭据已就绪 → 触发一次 tryStart；
 *  - 成功 → 停止重试（不重复拉管线）；仍失败 → 保持 blocker 状态，下轮继续；
 *  - **fail-closed 不变**：缺失期间绝不调用 tryStart，只解决"恢复能力"，不改变"缺失不启动"。
 */
export function createCredentialRetry(deps: {
  intervalMs: number;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
  /** 返回当前 blocker 文案；undefined = 凭据已就绪（可尝试启动） */
  describeBlocker(): string | undefined;
  /** 凭据就绪后的启动尝试（内部已有自己的 try/catch，失败经返回值/状态反映） */
  tryStart(): Promise<void>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let blocked = true;
  let recovered = false;

  const check = async (): Promise<void> => {
    if (recovered) return;
    const blocker = deps.describeBlocker();
    if (blocker !== undefined) {
      blocked = true;
      return; // 缺失 → 绝不启动（fail-closed）
    }
    // 就绪 → 尝试恢复启动（tryStart 内部自带异常处理；此处再兜一层防定时器崩进程）
    try {
      await deps.tryStart();
      recovered = true;
      blocked = false;
      deps.logger?.info?.("凭据已就绪，桥自动恢复启动成功（M32：无需重启宿主）");
      stop();
    } catch (err) {
      deps.logger?.error?.(`凭据就绪但自动恢复启动失败（下轮继续重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => void check(), deps.intervalMs);
    timer.unref?.();
  };
  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    start,
    stop,
    /** 当前是否仍处于"凭据缺失"阻断状态 */
    blocked: (): boolean => blocked,
  };
}
