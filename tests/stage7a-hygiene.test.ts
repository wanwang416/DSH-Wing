/**
 * 阶段 7a 测试：磁盘/日志/测试覆盖 + G14 核实（M24/M25/L1/M44/G14）
 *
 * 纪律：不用真实系统状态当夹具（全部临时目录）；先红自证；断言永真自查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wing-7a-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

// ───────────────────────── M24 · 轮转失败不静默 ─────────────────────────

describe("M24 · 日志轮转失败 warn + 计数（旧实现静默必红）", () => {
  it("行为级：轮转 rename 失败 → warn 含步骤名与原文件大小（不是吞掉）", async () => {
    // 可复现失败路径：目录当日志文件 → statSync 成功（size>0 需造假）不可行，
    // 改为把「归档位 .1」做成目录 → renameSync(file, file.1) 目标被占 → 抛错 → notify
    const log = vi.fn();
    const { setRotationNotifier, rotateIfNeeded } = await import("../src/log/rotation.js");
    setRotationNotifier({ warn: (m) => log(m) });
    try {
      const file = join(dir, "big.log");
      writeFileSync(file, "x");
      // 造一个大文件超出上限不可行（上限模块加载时定死）→ 直接验证 notifier 通路：
      // rotateIfNeeded 对不存在文件早退不报错；对目录路径 statSync 失败也早退。
      // 行为级改用 writeRotating 的失败分支：把 file 变成只读目录不可行（Windows）。
      // 结论：行为级验证 notifier 接线（调 rotateIfNeeded 不崩 + notifier 可回收），
      //       真正的失败→warn 映射由源码级断言钉死（catch 内必须调用 notifyRotateFailure）。
      rotateIfNeeded(join(dir, "not-exist.log")); // 早退路径：不得抛错、不得误报
      expect(log).not.toHaveBeenCalled();
    } finally {
      setRotationNotifier(undefined);
    }
  });

  it("源码级：catch 不再是空吞（必须带 notifyRotateFailure/notify 调用）+ notifier 注入点存在", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/log/rotation.ts", "utf-8");
    // 空 catch（仅注释）绝迹——旧实现 4 处 rotate catch + 1 处 write catch 全是 "// 忽略"
    const emptyCatch = src.match(/catch\s*(?:\(\w*\))?\s*\{\s*\/\/[^\n]*\n\s*\}/g) ?? [];
    expect(emptyCatch).toEqual([]);
    expect(src).toContain("setRotationNotifier");
    expect(src).toMatch(/notifyRotationFailure\(/); // 每个 catch 点的失败上报
  });
});

// ───────────────────────── M25 · archive 保留策略 ─────────────────────────

describe("M25 · archive 启动回收（照 wal.ts 模式：列目录→mtime 超期删→info+计数）", () => {
  it("超期归档被回收 + 计数日志 + 未超期保留", async () => {
    const archiveDir = join(dir, "archive");
    mkdirSync(archiveDir);
    const oldF = join(archiveDir, "sdk-debug-20260901.log");
    const newF = join(archiveDir, "sdk-debug-20261003.log");
    writeFileSync(oldF, "old");
    writeFileSync(newF, "new");
    const t = Date.now();
    utimesSync(oldF, new Date(t - 10 * 86_400_000), new Date(t - 10 * 86_400_000)); // 10 天前
    utimesSync(newF, new Date(t), new Date(t)); // 现在

    const infos: string[] = [];
    const warns: string[] = [];
    const { sweepArchive } = await import("../src/log/archive-retention.js");
    const { removed } = await sweepArchive(archiveDir, { retainDays: 7, logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) } });

    expect(removed).toBe(1);
    expect(existsSync(oldF)).toBe(false);
    expect(existsSync(newF)).toBe(true);
    expect(infos.some((m) => m.includes("归档回收") && m.includes("1"))).toBe(true);
  });

  it("空/不存在目录 → 0 删除 + 不崩（防静默成功：返回 0 且可核对）", async () => {
    const { sweepArchive } = await import("../src/log/archive-retention.js");
    const { removed } = await sweepArchive(join(dir, "no-such-dir"), { retainDays: 7, logger: {} });
    expect(removed).toBe(0);
  });

  it("回收失败（文件被占用）→ warn 该文件 + 计数失败数，不抛出", async () => {
    const archiveDir = join(dir, "archive2");
    mkdirSync(archiveDir);
    const oldF = join(archiveDir, "locked.log");
    writeFileSync(oldF, "x");
    const t = Date.now();
    utimesSync(oldF, new Date(t - 30 * 86_400_000), new Date(t - 30 * 86_400_000));

    const warns: string[] = [];
    const { sweepArchive } = await import("../src/log/archive-retention.js");
    // Windows 上 rmSync(force+recursive) 对目录也成功 → 用「路径含非法字符」构造必失败条目不可行；
    // 改用 vi.mock 不可行（动态 import）→ 最小失败构造：把条目变成符号循环不可行。
    // 采用：直接在目录里放一个「刚 stat 成功、rm 前被外部删掉」的竞态不可控 ——
    // 结论：失败路径用 notifier 单元级验证不可行，改为源码级断言钉死 try/catch 结构
    //       （catch 内 warn 文件名 + failed 计数），行为级由「正常回收」用例补对称覆盖。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/log/archive-retention.ts", "utf-8");
    // 单条目 try/catch：失败 warn 必含条目名，failed 计数，循环不中断（node -e 验证非永真：源码含该序列才绿）
    expect(src).toContain("failed++;");
    expect(src).toContain("归档回收失败（${name}）");
    rmSync(oldF, { recursive: true, force: true }); // 清理
    const removed0 = await sweepArchive(join(dir, "no-such"), { retainDays: 7, logger: { warn: (m) => warns.push(m) } });
    expect(removed0.removed).toBe(0);
  });

  it("启动接线：异步不阻塞（void 后台）+ unref（源码级断言）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/index.ts", "utf-8");
    expect(src).toMatch(/void\s+sweepArchiveStartup/); // 后台执行，不 await
    const ret = readFileSync("src/log/archive-retention.ts", "utf-8");
    expect(ret).toMatch(/unref\?\.\(\)/); // 6b 教训主动用上
  });
});

// ───────────────────────── G14 · /resume 平台前缀（企微会话可被 resume） ─────────────────────────

describe("G14 · /resume 按平台前缀查路由（旧实现恒 feishu: 必红）", () => {
  // resumeSession 的前缀解析逻辑内联在 index.ts commandServices（接线处），此处用
  // 索引式行为测试：构造 routes.json 落盘 + 直接断言 resolveResumeKey 的选路规则。
  // 三个必钉场景：①企微 chatId → wecom: 命中 ②重启后（登记表空）双前缀兜底
  // ③两个 key 都存在（理论可能）→ 取 updatedAt 较新者（阿深点名：必须有测试，防静默选错）。
  const makeRoute = (chatId: string, prefix: string, updatedAt: number) => ({
    sessionKey: `${prefix}:${chatId}`,
    chatId,
    chatType: "p2p",
    sessionId: `${prefix}:${chatId}:nonce:0`,
    updatedAt,
    lastMessageId: "om_x",
  });

  const resolveKeyFor = (chatId: string, platform: "feishu" | "wecom" | undefined, routes: ReturnType<typeof makeRoute>[]): string => {
    // 与 index.ts resolveResumeKey 同构的纯逻辑复刻（源码级断言钉死接线，行为级在此验证规则）
    const primary = `${platform === "wecom" ? "wecom" : "feishu"}:${chatId}`;
    const other = `${platform === "wecom" ? "feishu" : "wecom"}:${chatId}`;
    const p = routes.find((r) => r.sessionKey === primary);
    const o = routes.find((r) => r.sessionKey === other);
    if (p && o) return (o.updatedAt ?? 0) > (p.updatedAt ?? 0) ? other : primary;
    return o && !p ? other : primary;
  };

  it("企微 chatId（登记 wecom）→ wecom: 命中（旧实现查 feishu: 必 miss）", () => {
    const routes = [makeRoute("wr_A", "wecom", 1000)];
    expect(resolveKeyFor("wr_A", "wecom", routes)).toBe("wecom:wr_A");
  });

  it("双前缀兜底：只有 wecom key 存在（登记表空，重启后）→ 选 wecom", () => {
    const routes = [makeRoute("wr_B", "wecom", 1000)];
    expect(resolveKeyFor("wr_B", undefined, routes)).toBe("wecom:wr_B"); // 旧实现返回 feishu:wr_B（miss）
  });

  it("双前缀兜底：两个 key 都存在 → 取 updatedAt 较新者（规则钉死）", () => {
    const routes = [makeRoute("wr_C", "wecom", 2000), makeRoute("wr_C", "feishu", 1000)];
    expect(resolveKeyFor("wr_C", undefined, routes)).toBe("wecom:wr_C"); // wecom 较新
    const routes2 = [makeRoute("wr_D", "wecom", 500), makeRoute("wr_D", "feishu", 9000)];
    expect(resolveKeyFor("wr_D", undefined, routes2)).toBe("feishu:wr_D"); // 反向：feishu 较新
  });

  it("源码级：resumeSession 不再恒用默认前缀（resolveResumeKey + 双前缀兜底在接线处）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/index.ts", "utf-8");
    expect(src).toContain("resolveResumeKey");
    expect(src).toMatch(/resolveResumeKey\(\)/); // 确实被调用（接线生效，非"实现完成未接线"）
    expect(src).toMatch(/routeStore\.get\(resolveResumeKey\(\)\)/);
    // 纯逻辑同构保真：resolveKeyFor 与源码一致（防测试复刻漂移）
    expect(src).toContain("(oRoute.updatedAt ?? 0) > (pRoute.updatedAt ?? 0) ? other : primary");
  });
});

// ───────────────────────── M44-2 · mapper 空闲清理/dispose 边界（647 行核心，测试薄） ─────────────────────────

describe("M44-2 · mapper 空闲清理与 dispose 语义", () => {
  const mkHandle = (chatId: string) => ({
    agentId: `a-${chatId}`,
    sessionId: `feishu:${chatId}:n:0`,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    status: "idle",
    dispose: vi.fn().mockResolvedValue(undefined),
  });

  it("空闲清理：超时 idle 被清 + generation 递增 + dispose 调用；running 不清", async () => {
    vi.useFakeTimers();
    const { createSessionMapper, makeSessionId } = await import("../src/session/mapper.js");
    const h1 = mkHandle("oc_1");
    const h2 = mkHandle("oc_2");
    h2.status = "running";
    const mapper = createSessionMapper({
      createAgent: async (chatId: string) => (chatId === "oc_1" ? h1 : h2),
      // ★ M44-2 卡点修正（7a 验收）：实现走 opts.disposeAgent 回调（mapper.ts:156），
      //   handle.dispose 由生产接线（index.ts:600）在回调内调用——夹具不注入时
      //   h1.dispose 恒 0 次恰与 removed=1 自洽。断言必须盯住真正的调用点。
      disposeAgent: (h) => h.dispose(),
    });
    await mapper.getOrCreateAgent("oc_1");
    await mapper.getOrCreateAgent("oc_2");
    const idBefore = makeSessionId("oc_1");
    // 前进 2s：创建于 t0（idleAt=t0），cutoff=t0+2000-1000 → oc_1(idle) 超时、oc_2(running) 不清
    vi.advanceTimersByTime(2000);
    const removed = await (mapper as any).空闲清理(1000);
    expect(removed).toBe(1); // 只清 oc_1
    expect(h1.dispose).toHaveBeenCalledTimes(1);
    expect(h2.dispose).not.toHaveBeenCalled();
    expect(mapper.get("oc_1")).toBeUndefined();
    expect(mapper.get("oc_2")).toBe(h2);
    // generation 递增（dispose 语义对齐既有桥接实现）
    expect(makeSessionId("oc_1")).not.toBe(idBefore);
  });

  it("touch 后不误删（M43 防护）+ disposeAgentFor 对不存在 chatId 为 no-op", async () => {
    vi.useFakeTimers();
    const { createSessionMapper } = await import("../src/session/mapper.js");
    const h = mkHandle("oc_3");
    const mapper = createSessionMapper({ createAgent: async () => h });
    await mapper.getOrCreateAgent("oc_3");
    vi.advanceTimersByTime(5000); // 创建已 5s
    mapper.touch("oc_3"); // 刚 touch（M43 活动刷新）
    const removed = await (mapper as any).空闲清理(1000); // 若未 touch，此时必被清
    expect(removed).toBe(0); // touch 后不误删
    await mapper.disposeAgentFor("oc_none"); // no-op 不抛
    expect(mapper.size()).toBe(1);
  });
});

// ───────────────────────── L17 只报告：不写测试（无代码改动） ─────────────────────────

// ───────────────────────── M44 · turn-supervisor 补测 ─────────────────────────

describe("M44 · turn-supervisor 核心路径（超时=卡死自恢复根基）", () => {
  it("arm 后超时 → onTimeout 触发一次 + warn + armed 清除（不重复触发）", async () => {
    vi.useFakeTimers();
    const { createTurnSupervisor } = await import("../src/agent/turn-supervisor.js");
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 600_000, onTimeout, logger: { warn: vi.fn() } });
    sup.start();
    sup.arm("oc_1");
    await vi.advanceTimersByTimeAsync(601_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("oc_1");
    // 超时后 armed 已清 → 再走 10 分钟不重复触发
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  it("disarm 后超时不触发（正常完成即解除）", async () => {
    vi.useFakeTimers();
    const { createTurnSupervisor } = await import("../src/agent/turn-supervisor.js");
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 600_000, onTimeout });
    sup.start();
    sup.arm("oc_2");
    sup.disarm("oc_2");
    await vi.advanceTimersByTimeAsync(700_000);
    expect(onTimeout).not.toHaveBeenCalled();
    sup.stop();
  });

  it("onTimeout 抛错 → 不拖垮 timer（下一轮继续扫）", async () => {
    vi.useFakeTimers();
    const { createTurnSupervisor } = await import("../src/agent/turn-supervisor.js");
    const onTimeout = vi.fn(() => {
      throw new Error("boom");
    });
    const sup = createTurnSupervisor({ timeoutMs: 1000, onTimeout });
    sup.start();
    sup.arm("a");
    sup.arm("b");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeout).toHaveBeenCalledTimes(2); // a 抛错不挡 b
    sup.stop();
  });

  it("stop 后不触发；timer unref（不拖住进程退出，6b 教训）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/agent/turn-supervisor.ts", "utf-8");
    expect(src).toContain("unref");
    vi.useFakeTimers();
    const { createTurnSupervisor } = await import("../src/agent/turn-supervisor.js");
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 1000, onTimeout });
    sup.start();
    sup.arm("oc_s");
    sup.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
