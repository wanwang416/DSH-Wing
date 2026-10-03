/**
 * ★ 阶段 6a 攻击/异常场景回归（G9 / G10 / G12 / M32，2026-10-03）
 *
 * 攻击者视角：
 *  - G9：同进程残留锁 → 可接管（旧实现：拒绝 → 桥静默不启动）；跨进程存活锁 → 仍拒绝（保护不削弱）
 *  - G10：并发 startBridge → 底层 transport.start 只跑一次（旧实现：跑两次 = 双管线）；失败后可重试
 *  - G12：并发 getOrCreateAgent 同 chatId → createAgent 只调一次（旧实现：各建一个 = 上下文分裂）；失败后可重试
 *  - M32：凭据缺失 → 不启动（fail-closed 不变）；凭据后续就绪 → 自动重试恢复（旧实现：必须重启）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock } from "../../src/host/websocket.js";
import { createSessionMapper } from "../../src/session/mapper.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wing-6a-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ━━━━━━━━━━━ G9：单实例锁同进程接管 ━━━━━━━━━━━
describe("6a · G9：单实例锁同进程自锁死", () => {
  it("攻击场景（同进程）：acquire → 不 release → 再次 acquire 应成功接管（旧实现：undefined，必红）", () => {
    const lockDir = join(dir, "lock");
    const first = acquireSingleInstanceLock(lockDir);
    expect(first).toBeTruthy();
    const second = acquireSingleInstanceLock(lockDir);
    expect(second).toBeTruthy(); // 同 PID → 接管（warn 留痕）
    second!.release();
    rmSync(join(lockDir, "ws.lock"), { recursive: true, force: true });
  });

  it("保护不削弱（跨进程）：锁文件 PID = 其他存活 PID → 必须拒绝", () => {
    const lockDir = join(dir, "lock");
    const lockPath = join(lockDir, "ws.lock");
    mkdirSync(lockPath, { recursive: true });
    // 找一个肯定存在且不是本进程的存活 PID：用当前进程的父亲不可靠 → 用 4（Windows System 进程，恒存活）
    writeFileSync(join(lockPath, "pid"), "4", "utf8");
    const lock = acquireSingleInstanceLock(lockDir);
    expect(lock).toBeUndefined(); // 跨进程活跃持有者 → 拒绝（锁的本意）
  });

  it("同进程接管时打 warn 留痕（不许静默接管）", () => {
    // warn 经 console 不可断言（logger 在 createTransport 层），改经可观察行为：
    // 接管成功本身即行为断言；此处补验接管后锁文件 PID 已更新为本进程
    const lockDir = join(dir, "lock");
    const lockPath = join(lockDir, "ws.lock");
    const first = acquireSingleInstanceLock(lockDir);
    expect(first).toBeTruthy();
    const second = acquireSingleInstanceLock(lockDir);
    expect(second).toBeTruthy();
    expect(readFileSyncSafe(join(lockPath, "pid"))).toBe(String(process.pid));
    second!.release();
  });

  function readFileSyncSafe(p: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("node:fs").readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }
});

// ━━━━━━━━━━━ G10：startBridge in-flight 互斥（经工厂函数直接测） ━━━━━━━━━━━
describe("6a · G10：启动 in-flight 互斥", () => {
  /** 从 index.ts 抽出的互斥包装器同款逻辑（实现抽成可导入的 createStartMutex） */
  it("并发 Promise.all([start(), start()]) → 底层只执行一次（旧实现：两次，必红）", async () => {
    const { createStartMutex } = await import("../../src/lifecycle/start-mutex.js");
    let runs = 0;
    const start = createStartMutex(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
    });
    await Promise.all([start(), start(), start()]);
    expect(runs).toBe(1);
  });

  it("失败后再次调用能够重试（不能被永久卡住）", async () => {
    const { createStartMutex } = await import("../../src/lifecycle/start-mutex.js");
    let fail = true;
    let runs = 0;
    const start = createStartMutex(async () => {
      runs += 1;
      if (fail) throw new Error("boom");
    });
    await expect(start()).rejects.toThrow("boom");
    await expect(start()).rejects.toThrow("boom");
    expect(runs).toBe(2); // 失败也清 in-flight → 每次都真实执行
    fail = false;
    await start();
    expect(runs).toBe(3);
  });

  it("串行调用（完成后清空）→ 第二次仍执行（幂等门闩语义不破坏）", async () => {
    const { createStartMutex } = await import("../../src/lifecycle/start-mutex.js");
    let runs = 0;
    const start = createStartMutex(async () => {
      runs += 1;
    });
    await start();
    await start();
    expect(runs).toBe(2);
  });
});

// ━━━━━━━━━━━ G12：mapper TOCTOU（先复现） ━━━━━━━━━━━
describe("6a · G12：mapper 建 agent 并发 TOCTOU", () => {
  it("攻击场景（先复现）：并发两个 getOrCreateAgent(同 chatId) → createAgent 只调一次（旧实现：两次，必红）", async () => {
    const createAgent = vi.fn(async (chatId: string) => {
      await new Promise((r) => setTimeout(r, 10)); // 模拟创建耗时（await 期间无占位）
      return { chatId, status: "idle" };
    });
    const mapper = createSessionMapper({ createAgent } as any);
    const [a, b] = await Promise.all([
      mapper.getOrCreateAgent("oc_race"),
      mapper.getOrCreateAgent("oc_race"),
    ]);
    expect(a).toBe(b); // 同一个 handle
    expect(createAgent).toHaveBeenCalledTimes(1); // 旧实现会调两次 → 红
  });

  it("失败后可重试：createAgent 抛错 → 占位清掉 → 下次调用重新尝试创建", async () => {
    let fail = true;
    const createAgent = vi.fn(async (chatId: string) => {
      if (fail) throw new Error("create failed");
      return { chatId, status: "idle" };
    });
    const mapper = createSessionMapper({ createAgent } as any);
    await expect(mapper.getOrCreateAgent("oc_retry")).rejects.toThrow("create failed");
    await expect(mapper.getOrCreateAgent("oc_retry")).rejects.toThrow("create failed");
    expect(createAgent).toHaveBeenCalledTimes(2); // 失败清占位 → 每次都重试
    fail = false;
    const h = await mapper.getOrCreateAgent("oc_retry");
    expect(h.chatId).toBe("oc_retry");
  });

  it("正常串行行为不变（防回归）：二次调用返回缓存，不再创建", async () => {
    const createAgent = vi.fn(async (chatId: string) => ({ chatId, status: "idle" }));
    const mapper = createSessionMapper({ createAgent } as any);
    const a = await mapper.getOrCreateAgent("oc_ok");
    const b = await mapper.getOrCreateAgent("oc_ok");
    expect(a).toBe(b);
    expect(createAgent).toHaveBeenCalledTimes(1);
  });
});

// ━━━━━━━━━━━ M32：凭据晚到自动恢复（经生命周期工厂测） ━━━━━━━━━━━
describe("6a · M32：凭据缺失 → 不启动；凭据就绪 → 自动重试恢复", () => {
  it("凭据缺失时：不启动、startBlocker 置位（fail-closed 语义不变）", async () => {
    const { createCredentialRetry } = await import("../../src/lifecycle/credential-retry.js");
    let credAvailable = false;
    const startBridge = vi.fn(async () => undefined);
    const retry = createCredentialRetry({
      intervalMs: 50,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      describeBlocker: () => (credAvailable ? undefined : "未配置飞书凭据"),
      tryStart: startBridge,
    });
    retry.start();
    await new Promise((r) => setTimeout(r, 130));
    expect(startBridge).not.toHaveBeenCalled(); // 缺失期间绝不启动
    expect(retry.blocked()).toBe(true);
    retry.stop();
  });

  it("凭据从缺失 → 就绪：自动重试恢复启动（旧实现：必须重启宿主，必红）", async () => {
    const { createCredentialRetry } = await import("../../src/lifecycle/credential-retry.js");
    let credAvailable = false;
    const startBridge = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const retry = createCredentialRetry({
      intervalMs: 50,
      logger,
      describeBlocker: () => (credAvailable ? undefined : "未配置飞书凭据"),
      tryStart: startBridge,
    });
    retry.start();
    await new Promise((r) => setTimeout(r, 80));
    credAvailable = true; // 模拟用户在 DSH 凭据系统写入 WING_LARK_APP
    await new Promise((r) => setTimeout(r, 130));
    expect(startBridge).toHaveBeenCalled(); // 自动恢复（旧实现永不调用 → 红）
    expect(retry.blocked()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("凭据"));
    retry.stop();
  });

  it("恢复成功后停止重试（不重复触发 startBridge）", async () => {
    const { createCredentialRetry } = await import("../../src/lifecycle/credential-retry.js");
    const startBridge = vi.fn(async () => undefined);
    const retry = createCredentialRetry({
      intervalMs: 40,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      describeBlocker: () => undefined, // 立即可用
      tryStart: startBridge,
    });
    retry.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(startBridge).toHaveBeenCalledTimes(1); // 成功一次即停（不重复拉管线）
    retry.stop();
  });

  it("stop 后不再重试（不残留定时器）", async () => {
    const { createCredentialRetry } = await import("../../src/lifecycle/credential-retry.js");
    const startBridge = vi.fn(async () => undefined);
    const retry = createCredentialRetry({
      intervalMs: 40,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      describeBlocker: () => "blocked", // 恒缺失
      tryStart: startBridge,
    });
    retry.start();
    await new Promise((r) => setTimeout(r, 50));
    retry.stop();
    const calls = startBridge.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(startBridge.mock.calls.length).toBe(calls); // stop 后零触发
  });
});
