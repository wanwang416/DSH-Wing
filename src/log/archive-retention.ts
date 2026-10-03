/**
 * ★ M25（阶段7a）：`archive/` 归档目录保留策略。
 *
 * 背景：`wing/archive/` 在代码里**零写入点**（10-01 排障时手工归档进去的，实测 199 MB），
 * 因此本模块不做"写入点策略"，而是**启动时一次性回收**（照抄 wal.ts 段回收模式：
 * 列目录 → mtime 超期删 → info + 计数）。
 *
 * 两条硬性要求（阿深验收补充，已落实）：
 * 1. **不阻塞启动**：index.ts 以 `void sweepArchiveStartup(...)` 后台执行（不 await），
 *    内部 setTimeout 0 + `.unref?.()` 避免拖住进程退出（6b unref 教训主动用上）；
 * 2. **单次回收有上限**：一次最多删 `maxPerSweep`（默认 50）个文件，删满即止，
 *    下次启动继续（极端大量积压不会长时间占用磁盘 IO）。
 *
 * 可调环境变量：`DSH_WING_ARCHIVE_RETAIN_DAYS`（默认 7，对齐 outbox retainDays 基底）
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** 默认保留天数（对齐 outbox/WAL 的 7 天基底，不另发明取值） */
export const DEFAULT_ARCHIVE_RETAIN_DAYS = 7;
/** 单次回收上限（个），防止极端积压长时间占用 */
export const DEFAULT_MAX_PER_SWEEP = 50;

export interface ArchiveSweepDeps {
  retainDays?: number;
  maxPerSweep?: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  now?: () => number;
}

/**
 * 同步扫一遍 archive 目录并回收超期文件。返回 { removed, failed } 计数（可核对，拒绝静默）。
 * 目录不存在/为空 → { removed: 0, failed: 0 }（不算错误，info 可核对）。
 */
export function sweepArchive(
  dir: string,
  deps: ArchiveSweepDeps = {},
): { removed: number; failed: number } {
  const retainDays = deps.retainDays ?? (Number(process.env.DSH_WING_ARCHIVE_RETAIN_DAYS ?? "") || DEFAULT_ARCHIVE_RETAIN_DAYS);
  const maxPerSweep = deps.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const now = deps.now ?? Date.now;
  const retainMs = retainDays * 86_400_000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: 0, failed: 0 }; // 目录不存在（从未手工归档过）→ 无需回收
  }

  let removed = 0;
  let failed = 0;
  for (const name of entries) {
    if (removed >= maxPerSweep) {
      deps.logger?.info?.(`归档回收：本批已达单次上限 ${maxPerSweep} 个，余量下次启动继续`);
      break;
    }
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (now() - st.mtimeMs > retainMs) {
        rmSync(full, { force: true, recursive: true }); // recursive：目录条目（整包归档）也能清
        removed++;
      }
    } catch (err) {
      failed++;
      deps.logger?.warn?.(`归档回收失败（${name}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.logger?.info?.(
    `归档回收：删除 ${removed} 个超期条目（>${retainDays} 天，单次上限 ${maxPerSweep}）${failed > 0 ? `，失败 ${failed} 个` : ""}`,
  );
  return { removed, failed };
}

/**
 * 启动接线：后台异步回收（不阻塞 bridge 启动）。
 * setTimeout(0) 丢进 macrotask → unref 后不拖住进程退出。
 * 返回计时器句柄（测试可 await 句柄上的回调；生产忽略返回值）。
 */
export function sweepArchiveStartup(dir: string, deps: ArchiveSweepDeps = {}): { unref: () => void } | undefined {
  const timer = setTimeout(() => {
    try {
      sweepArchive(dir, deps);
    } catch (err) {
      // 兜底：sweep 内部已逐条 try/catch，此处防御未来改动引入的抛出
      deps.logger?.warn?.(`归档回收异常中止: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 0);
  timer.unref?.();
  return timer as unknown as { unref: () => void };
}
