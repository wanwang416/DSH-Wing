import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox } from "../../src/outbound/outbox.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-outbox-p1-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DAY = 86_400_000;

/** 直接写一条信封进 seg 文件（模拟历史磁盘状态），createdAt 可回拨 */
function seedEnvelope(dir: string, over: Partial<{ id: string; dedupeKey: string; status: string; attempts: number; createdAt: number }> = {}) {
  const env = {
    id: over.id ?? "env-1",
    dedupeKey: over.dedupeKey ?? "k-seed",
    chatId: "oc_1",
    kind: "text",
    payload: { kind: "text", text: "种子信封" },
    status: over.status ?? "failed",
    attempts: over.attempts ?? 3,
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    lastError: "Request failed with status code 429",
  };
  const seg = join(dir, `seg-${Math.floor(Date.now() / 1000)}.jsonl`);
  writeFileSync(seg, JSON.stringify(env) + "\n", { flag: "a" });
  return env;
}

describe("outbox P1-2A：超期 failed 不回队（防重启翻旧账）", () => {
  it("createdAt = 8 天前的 failed → 不回队（deliver 不被调用）+ warn 计数", async () => {
    const dir = tmpDir();
    seedEnvelope(dir, { id: "old-1", dedupeKey: "k-old", createdAt: Date.now() - 8 * DAY });
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, retainDays: 7, logger });
    await outbox.start();
    await sleep(150);
    expect(deliver).not.toHaveBeenCalled(); // ★ 旧实现会回队重发 15 天前的旧消息
    expect(outbox.failedCount()).toBe(1); // 保持 failed，不回队不删除
    expect(outbox.pendingCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("超期 failed"));
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("createdAt = 1 天前的 failed → 回队并被投递（未超期行为不变）", async () => {
    const dir = tmpDir();
    seedEnvelope(dir, { id: "fresh-1", dedupeKey: "k-fresh", createdAt: Date.now() - 1 * DAY });
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, retainDays: 7, logger });
    await outbox.start();
    await sleep(150);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(outbox.failedCount()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("超期 failed"));
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("超期 pending 不受影响（retainDays 只闸 failed 回队，不闸 pending）", async () => {
    const dir = tmpDir();
    seedEnvelope(dir, { id: "old-pending", dedupeKey: "k-old-pending", status: "pending", createdAt: Date.now() - 8 * DAY });
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, retainDays: 7 });
    await outbox.start();
    await sleep(150);
    expect(deliver).toHaveBeenCalledTimes(1); // pending 始终投递
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retainDays 可覆盖（retainDays: 1 → 2 天前的 failed 也不回队）", async () => {
    const dir = tmpDir();
    seedEnvelope(dir, { id: "old-2", dedupeKey: "k-old2", createdAt: Date.now() - 2 * DAY });
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, retainDays: 1 });
    await outbox.start();
    await sleep(150);
    expect(deliver).not.toHaveBeenCalled();
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("outbox P1-2B：seg 段文件回收", () => {
  it("2 个 8 天前的段被删、新段保留、info 计数正确", async () => {
    const dir = tmpDir();
    const oldSec = Math.floor((Date.now() - 8 * DAY) / 1000);
    const newSec = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, `seg-${oldSec}.jsonl`), "x\n");
    writeFileSync(join(dir, `seg-${oldSec + 10}.jsonl`), "x\n");
    writeFileSync(join(dir, `seg-${newSec}.jsonl`), "x\n");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const outbox = createOutbox({ dir, deliver: vi.fn().mockResolvedValue({ ok: true }), retainDays: 7, logger });
    await outbox.start();
    await sleep(50);
    expect(existsSync(join(dir, `seg-${oldSec}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `seg-${oldSec + 10}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `seg-${newSec}.jsonl`))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("outbox 段回收：删除 2 个旧段"));
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("非 seg-<数字>.jsonl 命名的文件不删（安全护栏）", async () => {
    const dir = tmpDir();
    const oldSec = Math.floor((Date.now() - 8 * DAY) / 1000);
    const newestOldSec = oldSec + 60; // ★ M46：需要两个超期段，"非最新段"才应被回收
    writeFileSync(join(dir, "seg-not-a-number.jsonl"), "x\n"); // 不匹配 seg-<数字>
    writeFileSync(join(dir, `seg-${oldSec}.jsonl`), "x\n");
    writeFileSync(join(dir, `seg-${newestOldSec}.jsonl`), "x\n");
    writeFileSync(join(dir, "other-file.jsonl"), "x\n");
    const outbox = createOutbox({ dir, deliver: vi.fn().mockResolvedValue({ ok: true }), retainDays: 7 });
    await outbox.start();
    await sleep(50);
    expect(existsSync(join(dir, "seg-not-a-number.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "other-file.jsonl"))).toBe(true);
    // 超期且非最新 → 回收；超期但是最新 → 保留（M46）
    expect(existsSync(join(dir, `seg-${oldSec}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `seg-${newestOldSec}.jsonl`))).toBe(true);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("7 天内（边界内）的段不删", async () => {
    const dir = tmpDir();
    const recentSec = Math.floor((Date.now() - 6 * DAY) / 1000);
    writeFileSync(join(dir, `seg-${recentSec}.jsonl`), "x\n");
    const outbox = createOutbox({ dir, deliver: vi.fn().mockResolvedValue({ ok: true }), retainDays: 7 });
    await outbox.start();
    await sleep(50);
    expect(existsSync(join(dir, `seg-${recentSec}.jsonl`))).toBe(true);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("★ M46：全部段都超期时，最新段仍被保留（防未发送消息随段被删）", async () => {
    const dir = tmpDir();
    const nineDaysSec = Math.floor((Date.now() - 9 * DAY) / 1000);
    const eightDaysSec = Math.floor((Date.now() - 8 * DAY) / 1000);
    writeFileSync(join(dir, `seg-${nineDaysSec}.jsonl`), "x\n");
    writeFileSync(join(dir, `seg-${eightDaysSec}.jsonl`), "x\n"); // 更晚 → 最新段
    const logger = { info: vi.fn(), warn: vi.fn() };
    const outbox = createOutbox({ dir, deliver: vi.fn().mockResolvedValue({ ok: true }), retainDays: 7, logger });
    await outbox.start();
    await sleep(50);
    // 旧实现：两段都超期 → 都删；若段内有 pending，消息永久丢失（连"不回队"的兜底都轮不上）
    expect(existsSync(join(dir, `seg-${nineDaysSec}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `seg-${eightDaysSec}.jsonl`))).toBe(true); // ★ 最新段保留
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("保留最新 1 段"));
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("★ M46：最新段被保留后，其内 pending 消息仍能被重建投递", async () => {
    const dir = tmpDir();
    const eightDaysSec = Math.floor((Date.now() - 8 * DAY) / 1000);
    const env = {
      id: "m46-pending",
      dedupeKey: "k-m46",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "停产期未发完的消息" },
      status: "pending",
      attempts: 1,
      createdAt: Date.now() - 8 * DAY,
      updatedAt: Date.now() - 8 * DAY,
    };
    writeFileSync(join(dir, `seg-${eightDaysSec}.jsonl`), JSON.stringify(env) + "\n");
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver, retainDays: 7 });
    await outbox.start();
    await sleep(120);
    expect(existsSync(join(dir, `seg-${eightDaysSec}.jsonl`))).toBe(true); // 段没被删
    expect(deliver).toHaveBeenCalledTimes(1); // pending 仍然被投递（不丢）
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("outbox P1-2C：重建队列去重 + 日志文案（体检 M45）", () => {
  it("同一 id 多行状态记录（pending→sending→pending）→ 队列条数 = 唯一 id 数", async () => {
    const dir = tmpDir();
    const base = {
      id: "dup-1",
      dedupeKey: "k-dup",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "重复行" },
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const seg = join(dir, `seg-${Math.floor(Date.now() / 1000)}.jsonl`);
    // 同一 id 三种状态三行（真实历史写法：每次状态变化 append 一行）
    writeFileSync(seg, [
      JSON.stringify({ ...base, status: "pending" }),
      JSON.stringify({ ...base, status: "sending" }),
      JSON.stringify({ ...base, status: "pending" }),
      "", // 尾空行
    ].join("\n"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, logger });
    await outbox.start();
    await sleep(150);
    // ★ 旧实现：queue 3 条（21 条待发送 / 12 条信封）；修复后只回队一次且成功投递
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("队列 1 条"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("唯一 id 1"));
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
