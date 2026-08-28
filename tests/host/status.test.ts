import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusStore } from "../../src/host/status.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "wing-status-")), "status.json");
}

describe("createStatusStore", () => {
  it("默认 idle + 全零计数器", () => {
    const s = createStatusStore(tmpFile());
    expect(s.get()).toMatchObject({ connState: "idle", outboxPending: 0, sessions: 0, wsReady: false });
  });

  it("update 合并 patch + 持久化（重启保留）", () => {
    const file = tmpFile();
    const s1 = createStatusStore(file);
    s1.update({ wsReady: true, lastProbeOk: true });
    expect(s1.get().wsReady).toBe(true);
    // 重启
    const s2 = createStatusStore(file);
    expect(s2.get().wsReady).toBe(true);
    expect(s2.get().lastProbeOk).toBe(true);
  });

  it("setConn connected → 记录 connectedAt", () => {
    const file = tmpFile();
    const s = createStatusStore(file, () => 12345);
    s.setConn("connected");
    expect(s.get().connState).toBe("connected");
    expect(s.get().connectedAt).toBe(12345);
  });

  it("setConn 非 connected 不带 connectedAt；extra 透传", () => {
    const file = tmpFile();
    const s = createStatusStore(file, () => 999);
    s.setConn("quarantined", { lastError: "boom" });
    expect(s.get().connState).toBe("quarantined");
    expect(s.get().lastError).toBe("boom");
    expect(s.get().connectedAt).toBeUndefined();
  });

  it("refreshCounters 更新计数器", () => {
    const file = tmpFile();
    const s = createStatusStore(file);
    s.refreshCounters({ outboxPending: 3, sessions: 5 });
    expect(s.get()).toMatchObject({ outboxPending: 3, sessions: 5 });
  });

  it("文件损坏 → 回退默认状态不崩溃", () => {
    const file = tmpFile();
    const { writeFileSync } = require("node:fs");
    writeFileSync(file, "{invalid json");
    const s = createStatusStore(file);
    expect(s.get().connState).toBe("idle");
  });

  it("get 返回副本（外部修改不影响内部）", () => {
    const file = tmpFile();
    const s = createStatusStore(file);
    const a = s.get();
    a.sessions = 999;
    expect(s.get().sessions).toBe(0);
  });
});
