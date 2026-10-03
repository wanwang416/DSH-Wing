/**
 * 落盘日志的轮转与级别过滤。
 *
 * 背景（2026-10-01 实测事故）：`wing/sdk-debug.log` 涨到 180.7 MB。
 * 根因是排障时设置 `DSH_WING_SDK_LOG` 会把飞书 SDK 的日志级别抬到 `debug`，
 * 而写入用的是 `appendFileSync`：无级别过滤、无大小上限、无归档轮转 ——
 * 开关一旦被遗忘就一路写下去。本模块给所有落盘日志补上"过滤 + 上限 + 归档"。
 *
 * 可调环境变量：
 * - `DSH_WING_LOG_MAX_BYTES` 单文件上限（默认 16 MiB）
 * - `DSH_WING_LOG_KEEP`      归档份数（默认 3）
 * - `DSH_WING_LOG_LEVELS`    `appendLevelLine` 允许的级别（默认 warn,error）
 */
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

/**
 * ★ M24（阶段7a）：轮转/写入失败不再静默——经 notifier 上报（warn + 步骤名 + 原文件大小）。
 * 模块级可设置回调（同 M27 stateDir 迁移思路：避免 rotation → index 循环依赖）；
 * index.ts apply 时 setRotationNotifier({ warn: logger.warn }) 接线。
 */
type RotationNotifier = { warn?: (msg: string) => void };
let rotationNotifier: RotationNotifier | undefined;

/** apply 时接线（不设则失败仍不上报——但空 catch 已绝迹，counters 仍累计可核对） */
export function setRotationNotifier(n: RotationNotifier | undefined): void {
  rotationNotifier = n;
}

/** 失败上报统一出口：warn（哪一步失败、原文件多大）+ 计数 */
let rotationFailures = 0;
export function rotationFailureCount(): number {
  return rotationFailures;
}
function notifyRotationFailure(file: string, step: string, err: unknown, originalSize?: number): void {
  rotationFailures++;
  const sizeInfo = originalSize !== undefined ? `，原文件 ${(originalSize / 1024 / 1024).toFixed(1)} MB` : "";
  rotationNotifier?.warn?.(
    `日志轮转失败（步骤=${step}${sizeInfo}）: ${file}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** 单文件上限（字节），默认 16 MiB。 */
export const LOG_MAX_BYTES: number = (() => {
  const raw = Number(process.env.DSH_WING_LOG_MAX_BYTES ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
})();

/** 保留的归档份数，默认 3（即最多占 LOG_MAX_BYTES × (LOG_KEEP + 1)）。 */
export const LOG_KEEP: number = (() => {
  const raw = Number(process.env.DSH_WING_LOG_KEEP ?? "");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();

/** 允许落盘的级别集合，默认只留 warn/error。 */
export const LOG_LEVELS: Set<string> = new Set(
  (process.env.DSH_WING_LOG_LEVELS ?? "warn,error")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * 超过上限时把 `file` 轮转为 `file.1`，旧归档依次后移，超出 LOG_KEEP 的删除。
 * 任何失败都不抛出：日志写入永远不能影响主流程。
 */
export function rotateIfNeeded(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return; // 文件尚不存在，无需轮转（这不是失败，不上报）
  }
  if (size < LOG_MAX_BYTES) return;

  const oldest = `${file}.${LOG_KEEP}`;
  try {
    if (existsSync(oldest)) rmSync(oldest, { force: true });
  } catch (err) {
    // ★ M24：不再静默
    notifyRotationFailure(file, `删除最旧归档 ${oldest}`, err, size);
  }
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${file}.${i + 1}`);
    } catch (err) {
      // ★ M24：不再静默
      notifyRotationFailure(file, `后移归档 ${from}→${file}.${i + 1}`, err, size);
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch (err) {
    // ★ M24：不再静默
    notifyRotationFailure(file, `主文件轮转 ${file}→${file}.1`, err, size);
  }
}

function writeRotating(file: string, line: string): void {
  try {
    rotateIfNeeded(file);
    appendFileSync(file, line);
  } catch (err) {
    // ★ M24：写文件失败也上报（不再静默；但不抛出——日志写入永远不影响主流程）
    notifyRotationFailure(file, "追加写入", err);
  }
}

/** 追加一行，不做级别过滤 —— 主日志用（所有级别都留，只加上限与归档）。 */
export function appendRotatingLine(file: string, line: string): void {
  writeRotating(file, line);
}

/** 追加一行，先按级别过滤再写 —— SDK 调试日志用（默认只留 warn/error）。 */
export function appendLevelLine(file: string, level: string, line: string): void {
  if (!LOG_LEVELS.has(level.toLowerCase())) return;
  writeRotating(file, line);
}
