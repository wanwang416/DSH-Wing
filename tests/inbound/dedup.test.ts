import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDedupeStore } from "../../src/inbound/dedup.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wing-dedup-"));
  return join(dir, "dedupe.jsonl");
}

describe("dedup", () => {
  it("新 messageId 返回 false，重复返回 true", () => {
    const file = tmpFile();
    const store = createDedupeStore(file);
    expect(store.isDuplicate("msg-1")).toBe(false);
    expect(store.add("msg-1")).toBe(true);
    expect(store.isDuplicate("msg-1")).toBe(true);
    expect(store.add("msg-1")).toBe(false); // 重复 add 返回 false
    expect(store.isDuplicate("msg-2")).toBe(false);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("TTL 过期后不再判重", () => {
    const file = tmpFile();
    let now = 1_000_000;
    const store = createDedupeStore(file, () => now, 24 * 60 * 60 * 1000);
    store.add("msg-1");
    expect(store.isDuplicate("msg-1")).toBe(true);
    now += 25 * 60 * 60 * 1000; // 过 25h
    expect(store.isDuplicate("msg-1")).toBe(false);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });
});
