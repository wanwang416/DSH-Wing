import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock, createTransport } from "../../src/host/websocket.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-ws-"));
}

/** 假 lark client：捕获事件注册，可手动触发事件回调 */
function makeClient(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (data: unknown) => void>();
  const on = vi.fn((event: string, handler: (data: unknown) => void) => {
    handlers.set(event, handler);
  });
  const ws = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
  const getBotInfo = vi.fn().mockResolvedValue({ open_id: "ou_bot" });
  const isWsReady = vi.fn().mockReturnValue(true);
  return {
    handlers,
    on,
    ws,
    getBotInfo,
    isWsReady,
    ...overrides,
  } as any;
}

function makeDeps(client: any, dir: string, overrides: Record<string, unknown> = {}) {
  return {
    getClient: () => client,
    onMessage: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    lockDir: join(dir, "lock"),
    ...overrides,
  };
}

describe("acquireSingleInstanceLock", () => {
  it("正常获取锁 + release 清理后可再获取", () => {
    const dir = tmpDir();
    const lock = acquireSingleInstanceLock(join(dir, "lock"));
    expect(lock).toBeTruthy();
    // 占用：再次获取返回 undefined
    expect(acquireSingleInstanceLock(join(dir, "lock"))).toBeUndefined();
    lock!.release();
    // 释放后重新可用
    expect(acquireSingleInstanceLock(join(dir, "lock"))).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("持有者 PID 已死（force kill 残留）→ 接管锁", () => {
    const dir = tmpDir();
    const lockPath = join(dir, "lock", "ws.lock");
    mkdirSync(lockPath, { recursive: true });
    // 写入一个必然不存在的 PID
    writeFileSync(join(lockPath, "pid"), "999999999", "utf8");
    const lock = acquireSingleInstanceLock(join(dir, "lock"));
    expect(lock).toBeTruthy();
    lock!.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("锁目录创建失败 → 返回 undefined", () => {
    // 用一个非法路径让 mkdir 失败（父目录是文件）
    const dir = tmpDir();
    const file = join(dir, "blocked");
    writeFileSync(file, "x", "utf8");
    expect(acquireSingleInstanceLock(join(file, "sub"))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createTransport.start 连接流程", () => {
  it("注册全部订阅事件（消息/卡片/撤回/bot进出群/表情）", async () => {
    const dir = tmpDir();
    const client = makeClient();
    const deps = makeDeps(client, dir);
    const t = createTransport(deps);
    await t.start();
    const registered = client.on.mock.calls.map((c: any[]) => c[0]);
    expect(registered).toContain("im.message.receive_v1");
    expect(registered).toContain("card.action.trigger");
    // ★ M4 返工：recalled 必须注册（此前死代码）
    expect(registered).toContain("im.message.recalled_v1");
    expect(registered).toContain("im.chat.member.bot.added_v1");
    expect(registered).toContain("im.chat.access_event.bot_p2p_chat_entered_v1");
    expect(registered).toContain("im.message.reaction.created_v1");
    expect(client.ws.start).toHaveBeenCalled();
    expect(t.botOpenId()).toBe("ou_bot");
    expect(t.wsReady()).toBe(true);
    expect(t.isConnected()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lark client 未就绪 → error 日志且不标记已启动", async () => {
    const dir = tmpDir();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = makeDeps(undefined, dir, { logger });
    const t = createTransport(deps);
    await t.start();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("未就绪"));
    expect(t.isConnected()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("单实例锁被占用 → warn 并跳过连接", async () => {
    const dir = tmpDir();
    // 先占用锁
    const lock = acquireSingleInstanceLock(join(dir, "lock"));
    const client = makeClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const t = createTransport(makeDeps(client, dir, { logger }));
    await t.start();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("锁被占用"));
    expect(client.ws.start).not.toHaveBeenCalled();
    expect(t.isConnected()).toBe(false);
    lock!.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("bot 信息获取失败不阻塞启动", async () => {
    const dir = tmpDir();
    const client = makeClient({ getBotInfo: vi.fn().mockRejectedValue(new Error("api down")) });
    const t = createTransport(makeDeps(client, dir));
    await t.start();
    expect(t.isConnected()).toBe(true);
    expect(t.botOpenId()).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createTransport 事件转发", () => {
  it("收到消息事件 → onEvent + onMessage 都被调用", async () => {
    const dir = tmpDir();
    const client = makeClient();
    const deps = makeDeps(client, dir);
    const t = createTransport(deps);
    await t.start();
    const data = { message: { message_id: "om_1" } };
    client.handlers.get("im.message.receive_v1")(data);
    expect(deps.onEvent).toHaveBeenCalledWith("im.message.receive_v1", data);
    expect(deps.onMessage).toHaveBeenCalledWith(data);
    expect(t.lastEventAt()).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("收到撤回事件 → 只转发 onEvent（不触发 onMessage 管线）", async () => {
    const dir = tmpDir();
    const client = makeClient();
    const deps = makeDeps(client, dir);
    const t = createTransport(deps);
    await t.start();
    const data = { message: { message_id: "om_x", chat_id: "oc_1" } };
    client.handlers.get("im.message.recalled_v1")(data);
    expect(deps.onEvent).toHaveBeenCalledWith("im.message.recalled_v1", data);
    expect(deps.onMessage).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("onMessage 抛错 → error 日志且不中断", async () => {
    const dir = tmpDir();
    const client = makeClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = makeDeps(client, dir, {
      logger,
      onMessage: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const t = createTransport(deps);
    await t.start();
    client.handlers.get("im.message.receive_v1")({});
    // handler 是 fire-and-forget，异步错误日志需等微任务 flush
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("onMessage failed")),
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createTransport stop / probe", () => {
  it("stop → ws.stop 被调 + 释放锁（可重新连接）", async () => {
    const dir = tmpDir();
    const client = makeClient();
    const deps = makeDeps(client, dir);
    const t = createTransport(deps);
    await t.start();
    await t.stop();
    expect(client.ws.stop).toHaveBeenCalled();
    expect(t.isConnected()).toBe(false);
    // 锁已释放 → 新实例可获取
    expect(acquireSingleInstanceLock(join(dir, "lock"))).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("probe 成功 → 更新 botOpenId 返回 true", async () => {
    const dir = tmpDir();
    const client = makeClient({ getBotInfo: vi.fn().mockResolvedValue({ open_id: "ou_new" }) });
    const deps = makeDeps(client, dir);
    const t = createTransport(deps);
    await t.start();
    expect(await t.probe()).toBe(true);
    expect(t.botOpenId()).toBe("ou_new");
    rmSync(dir, { recursive: true, force: true });
  });

  it("probe 失败 → 返回 false", async () => {
    const dir = tmpDir();
    const client = makeClient({ getBotInfo: vi.fn().mockRejectedValue(new Error("down")) });
    const t = createTransport(makeDeps(client, dir));
    await t.start();
    expect(await t.probe()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
