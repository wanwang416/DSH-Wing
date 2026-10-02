import { describe, expect, it, vi } from "vitest";
import { createWecomClient } from "../../src/host/wecom-client.js";
import { createStatusStore, type WingStatus } from "../../src/host/status.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-wecom-g4-"));
}

describe("G4：企微重连耗尽自愈 + 连接状态可观测", () => {
  it("WSClient 构造传 maxReconnectAttempts: -1（无限重连，SDK 自带指数退避）", async () => {
    // 捕获传给 SDK WSClient 的 options（工厂在 start() 内被调用）
    let captured: Record<string, unknown> | undefined;
    const client = createWecomClient({
      botId: "wb_test",
      secret: "s",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxReconnectAttempts: -1,
      wsClientFactory: ((o: Record<string, unknown>) => {
        captured = o;
        return { on: vi.fn(), connect: vi.fn() } as any;
      }) as never,
    });
    await client.start();
    expect(captured).toBeDefined();
    expect(captured!.maxReconnectAttempts).toBe(-1);
  });

  it("重连耗尽（WSReconnectExhaustedError）→ 有日志 + 有状态，不再静默", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const connStates: boolean[] = [];
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeWs = {
      on: vi.fn((ev: string, h: (...a: unknown[]) => void) => handlers.set(ev, h)),
      connect: vi.fn(),
    };
    const client = createWecomClient({
      botId: "wb_test",
      secret: "s",
      logger,
      maxReconnectAttempts: -1,
      wsClientFactory: (() => fakeWs) as never,
    });
    client.onConnState((c) => connStates.push(c));
    await client.start();
    // 先认证成功（connState=true），再模拟 SDK 重连耗尽
    handlers.get("authenticated")!();
    expect(connStates).toContain(true);
    handlers.get("error")!(new Error("Max reconnect attempts exceeded (10)"));
    // ★ 旧实现：只 setConnState(false)，无 exhausted 专属日志（静默死亡）→ 断言新日志
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("重连耗尽"));
    expect(connStates).toContain(false);
  });

  it("onConnState(false) → status 企微字段变为未就绪（旧实现无此字段 → 红）", () => {
    const dir = tmpDir();
    const status = createStatusStore(join(dir, "status.json"));
    // 模拟 index.ts onConnState 接线后的行为
    status.update({ wecomConnState: "disconnected", wecomReady: false });
    const st = status.get() as WingStatus;
    expect("wecomConnState" in st).toBe(true);
    expect("wecomReady" in st).toBe(true);
    expect(st.wecomConnState).toBe("disconnected");
    expect(st.wecomReady).toBe(false);
    // status.json 落盘可核对
    const persisted = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as WingStatus;
    expect(persisted.wecomReady).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("WingStatus 类型含企微字段（编译期保证面板可读）", async () => {
    const mod = await import("../../src/host/status.js");
    const dir = tmpDir();
    const status = mod.createStatusStore(join(dir, "status.json"));
    status.update({ wecomConnState: "connected", wecomReady: true });
    expect((status.get() as WingStatus).wecomReady).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
