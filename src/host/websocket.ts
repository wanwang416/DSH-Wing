/**
 * 飞书 WS 长连接传输层（M1）
 *
 * - 事件注册：im.message.receive_v1（M1 只此一个，card.action.trigger 留 M3）
 * - 单实例锁（铁律 5）：锁目录记录持有者 PID，force kill 残留锁可被存活检查接管
 * - CLOSE frame（铁律 6）：stop 时先 ws.stop()（SDK 会发 CLOSE frame）再释放锁
 * - M1 不做连接自愈（supervisor 是 M2）
 */

import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const EVENT_MESSAGE = "im.message.receive_v1";

export interface TransportDeps {
  getClient(): {
    on?(event: string, handler: (data: unknown) => void): void;
    ws?: { start(): void; stop(): Promise<void> };
    getBotInfo?(): Promise<{ open_id?: string }>;
    isWsReady?(): boolean;
  } | undefined;
  onMessage(msg: unknown): Promise<void>;
  onEvent?(event: string, data: unknown): void;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** 单实例锁目录（stateDir 下） */
  lockDir: string;
}

/** 陈旧锁兜底判定（无 PID 文件时用）：超过 10 分钟视为残留 */
const STALE_LOCK_MS = 10 * 60_000;

/** 检查进程是否存活（Windows/Node 通用） */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM = 存在但无权访问（算存活）
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 单实例锁：锁目录内 mkdir 获取锁 + 写 PID。
 * 已存在时：①持有者 PID 存活 → 返回 undefined（被占用）；
 *           ②持有者 PID 死了（force kill 残留）→ 接管；
 *           ③无 PID 文件 → 用 mtime 陈旧兜底。
 */
export function acquireSingleInstanceLock(lockDir: string): { release(): void } | undefined {
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch {
    return undefined;
  }
  const lockPath = join(lockDir, "ws.lock");
  const pidFile = join(lockPath, "pid");

  const makeLock = (): { release(): void } => {
    try {
      mkdirSync(lockPath, { recursive: false });
    } catch {
      return undefined as unknown as { release(): void };
    }
    try {
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    } catch {
      // 忽略
    }
    return {
      release() {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // 忽略
        }
      },
    };
  };

  // 尝试独占创建
  try {
    mkdirSync(lockPath, { recursive: false });
    try {
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    } catch {
      // 忽略
    }
    return {
      release() {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // 忽略
        }
      },
    };
  } catch {
    // 已存在：检查持有者
    // ① PID 文件 → 存活检查
    try {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (isPidAlive(pid)) return undefined; // 活跃持有者
        // 持有者已死：接管
        rmSync(lockPath, { recursive: true, force: true });
        return makeLock();
      }
    } catch {
      // PID 文件读失败，走陈旧兜底
    }
    // ② 无 PID 文件 → mtime 陈旧兜底
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        return makeLock();
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}

export function createTransport(deps: TransportDeps) {
  let started = false;
  let wsReadyFlag = false;
  let botOpenId: string | undefined;
  let lock: { release(): void } | undefined;

  async function handleEvent(event: string, data: unknown): Promise<void> {
    deps.onEvent?.(event, data);
    if (event !== EVENT_MESSAGE) return;
    try {
      await deps.onMessage(data);
    } catch (err) {
      deps.logger?.error?.(`onMessage failed: ${String(err)}`);
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      lock = acquireSingleInstanceLock(deps.lockDir);
      if (!lock) {
        deps.logger?.warn?.("WS 单实例锁被占用（另一实例活跃），跳过连接，防止同 App 双 WS 抢事件");
        return;
      }
      started = true;
      const c = deps.getClient();
      if (!c) {
        deps.logger?.error?.("lark client 未就绪");
        lock.release();
        lock = undefined;
        started = false;
        return;
      }
      if (c.on) {
        c.on(EVENT_MESSAGE, (data: unknown) => void handleEvent(EVENT_MESSAGE, data));
      }
      try {
        const bot = await c.getBotInfo?.();
        if (bot?.open_id) botOpenId = bot.open_id;
      } catch {
        // bot 信息获取失败不阻塞
      }
      try {
        c.ws?.start();
        // 等待 SDK onReady（异步连接，最长 10 秒）
        for (let i = 0; i < 20; i++) {
          if (typeof c.isWsReady === "function" && c.isWsReady()) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        wsReadyFlag = typeof c.isWsReady === "function" ? c.isWsReady() : true;
        if (wsReadyFlag) {
          deps.logger?.info?.("飞书 WS 已就绪");
        } else {
          deps.logger?.warn?.("飞书 WS 未就绪（SDK 连接超时/失败）");
        }
      } catch (err) {
        deps.logger?.error?.(`ws start failed: ${String(err)}`);
        wsReadyFlag = false;
      }
    },
    async stop(): Promise<void> {
      started = false;
      wsReadyFlag = false;
      try {
        // SDK stop 内部发送 WS CLOSE frame（铁律 6：先发 CLOSE 再断）
        await deps.getClient()?.ws?.stop?.();
      } catch {
        // 忽略
      }
      lock?.release();
      lock = undefined;
    },
    wsReady: () => wsReadyFlag,
    isConnected: () => started && wsReadyFlag,
    botOpenId: () => botOpenId,
    /** 探活：真实 API 调用检测连接假死（M2 完整 supervisor 的雏形） */
    async probe(): Promise<boolean> {
      try {
        const bot = await deps.getClient()?.getBotInfo?.();
        if (bot?.open_id) botOpenId = bot.open_id;
        return true;
      } catch {
        return false;
      }
    },
  };
}
