import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboundWal, type InboundWalRecord } from "../../src/inbound/wal.js";

let dir = "";
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  dir = join(tmpdir(), `wal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 预置 N 个旧段（模拟磁盘上历史残留的全量快照段） */
function seedSegs(count: number, records: InboundWalRecord[] = []): void {
  const base = 1_000_000_000_000;
  for (let i = 0; i < count; i++) {
    const name = `seg-${base + i * 1000}.jsonl`;
    writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

function segFiles(): string[] {
  return readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f) && !f.endsWith(".tmp"));
}

function readSeg(): string {
  return readFileSync(join(dir, segFiles()[0]), "utf8");
}

function makeRec(overrides: Partial<InboundWalRecord> = {}): InboundWalRecord {
  return {
    messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
    chatId: "oc_1",
    chatType: "p2p",
    text: "hello",
    acceptedAt: 1_000_000_000_000,
    attempts: 0,
    state: "delivered",
    ...overrides,
  };
}

describe("阶段4 A组：WAL 段回收（M1/M2/M20）", () => {
  it("M1：persistAll 写出新段后，旧段全部删除只留 1 段，并有回收计数日志（旧实现段数只增，必红）", () => {
    seedSegs(3);
    const wal = createInboundWal({ dir, logger });
    wal.accept({ messageId: "om_a", chatId: "oc_1", chatType: "p2p", text: "x" });
    expect(segFiles().length).toBe(1); // 旧实现=4
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("WAL 段回收"));
  });

  it("M1：records 为空时不再写出 1 字节空段（旧实现写 '\\n'，必红）", () => {
    seedSegs(2);
    const wal = createInboundWal({ dir, logger });
    wal.accept({ messageId: "om_b", chatId: "oc_1", chatType: "p2p", text: "y" });
    wal.remove("om_b"); // remove 后 records 空 → persistAll（旧实现此处写 1 字节 "\n" 空段）
    expect(segFiles().length).toBe(1);
    expect(readSeg().trim()).toBe(""); // 新实现：空记录写出 0 字节空文件或不写
  });

  it("M2：prune 删除落地——prune 后重建实例再 load，记录不复活（旧实现旧段残留必红）", () => {
    // 超次 accepted 记录：旧 prune 规则会删它（attempts>=maxReplayAttempts），
    // 但旧实现删后旧段残留 → 重启 load 复活为 accepted → pendingCount 虚高
    const stuck = makeRec({ messageId: "om_old", state: "accepted", attempts: 2, acceptedAt: 1_000_000_000_000 });
    seedSegs(1, [stuck]);
    const wal = createInboundWal({ dir, logger });
    wal.prune();
    expect(wal.pendingCount()).toBe(0);
    const wal2 = createInboundWal({ dir, logger: { info: vi.fn(), warn: vi.fn() } });
    expect(wal2.pendingCount()).toBe(0); // 旧实现=1（从残留旧段复活）
  });

  it("M20：超期未投递记录被 prune 清理并打计数日志（旧实现只清 delivered/超次，必红）", () => {
    const stale = makeRec({
      messageId: "om_stuck",
      state: "accepted",
      attempts: 0, // 旧实现：attempts<2 且非 delivered → 两边都不沾 → 永久滞留
      acceptedAt: 1_000_000_000_000,
    });
    seedSegs(1, [stale]);
    const wal = createInboundWal({ dir, logger });
    expect(wal.pendingCount()).toBe(1); // load 进来了
    wal.prune();
    expect(wal.pendingCount()).toBe(0); // 旧实现=1
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("WAL prune"));
  });

  it("M20：保留期内未投递记录不受 prune 影响（防误删）", () => {
    const fresh = makeRec({ messageId: "om_fresh", state: "accepted", attempts: 0, acceptedAt: Date.now() });
    seedSegs(1, [fresh]);
    const wal = createInboundWal({ dir, logger });
    wal.prune();
    expect(wal.pendingCount()).toBe(1);
  });
});
