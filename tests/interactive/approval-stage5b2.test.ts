/**
 * ★ 阶段 5b-2 攻击场景回归（G6-B 口径 / M5 / M6 / M14 / M42，2026-10-02）
 *
 * 攻击者视角：
 *  - G6-B（ALAN 拍板 B 方案）：群聊 Always 只对当初点它的那个人生效——老板免问、他人仍审批；
 *    p2p 行为不回归；拿不到发起者 → 不自动放行（fail-closed）
 *  - M5：企微群聊文本审批可命中（不再"提示发了但回复永不生效"）
 *  - M6：多审批并存时按编号匹配，回 A 结算 A（不串台）；乱编号 → 拒绝不猜
 *  - M14：记忆文件 tmp+rename 原子写；写失败原文件仍在
 *  - M42：settle 后定时器清除 + abort 监听摘除
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalBridge, buildApprovalText } from "../../src/interactive/approval.js";
import { messageIdOfRes } from "../../src/agent/user-questions.js";

/** 群聊场景 req（agent.id 的 chatId 段 = 群 id） */
const groupReq = (over: Record<string, unknown> = {}) => ({
  agent: { id: "feishu:oc_group:1:0" },
  toolName: "bash",
  reason: "运行危险命令",
  ...over,
});
/** p2p 场景 req（chatId ≡ 发起者 openId，parser 保证） */
const p2pReq = (over: Record<string, unknown> = {}) => ({
  agent: { id: "feishu:ou_boss:1:0" },
  toolName: "bash",
  reason: "运行危险命令",
  ...over,
});
const next = vi.fn(async () => "unavailable" as const);

let memDir: string;
let memFile: string;
beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "wing-approval-5b2-"));
  memFile = join(memDir, "approval-memory.json");
});
afterEach(() => rmSync(memDir, { recursive: true, force: true }));

function mkBridge(over: Record<string, unknown> = {}) {
  const sendCard = vi.fn().mockResolvedValue({ data: { message_id: "om_msg" } });
  const updateCard = vi.fn().mockResolvedValue(undefined);
  const sendText = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const bridge = createApprovalBridge({
    sendCard,
    updateCard,
    messageIdOf: messageIdOfRes,
    sendText,
    memoryFile: memFile,
    timeoutMs: 60_000,
    logger,
    bossOpenId: "ou_boss",
    ...over,
  } as any);
  return { bridge, sendCard, updateCard, sendText, logger };
}

/** 提取发卡 JSON 里的 entryId */
function entryIdOf(b: ReturnType<typeof mkBridge>): string {
  const id = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls.at(-1)?.[1]) ?? "")?.[1];
  expect(id).toBeDefined();
  return id!;
}

// ━━━━━━━━━━━ G6-B：群聊 Always 只对批准者本人生效 ━━━━━━━━━━━
describe("5b-2 · G6-B 口径：群聊 Always 只对批准者生效（initiatorOf）", () => {
  function mkWithInitiator(map: Record<string, string>) {
    return mkBridge({ initiatorOf: (chatId: string) => map[chatId] });
  }

  it("攻击场景：群聊老板点 Always → 老板本人再触发同工具 → 自动放行（旧实现：永不命中，必红）", async () => {
    const b = mkWithInitiator({ oc_group: "ou_boss" });
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    // 老板再次触发 → 免审批
    const p2 = b.bridge.answer(groupReq() as any, next as any);
    await expect(p2).resolves.toBe("allowed-once");
    expect(b.sendCard).toHaveBeenCalledTimes(1); // 第二次没发新卡
  });

  it("攻击场景：群聊老板点 Always → 其他人触发同工具 → 仍弹审批（不扩散，必红于无身份实现）", async () => {
    const b = mkWithInitiator({ oc_group: "ou_other" }); // 本 turn 发起者 ≠ 老板
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    // 他人发起的新 turn → 不命中老板的记忆 → 弹卡
    const p2 = b.bridge.answer(groupReq() as any, next as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sendCard).toHaveBeenCalledTimes(2); // 又发了一张审批卡
    await expect(expect(p2).resolves).toBeDefined();
  });

  it("p2p 行为与 5b-1 一致（防回归）：批准者=归属者 → 命中", async () => {
    const b = mkWithInitiator({}); // 无 initiatorOf 也不影响 p2p（chatId 顶替）
    const p = b.bridge.answer(p2pReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:always`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    const p2 = b.bridge.answer(p2pReq() as any, next as any);
    await expect(p2).resolves.toBe("allowed-once");
    expect(b.sendCard).toHaveBeenCalledTimes(1);
  });

  it("fail-closed：拿不到发起者（群聊无快照）→ 不自动放行，仍弹卡", async () => {
    const b = mkWithInitiator({}); // initiatorOf 返回 undefined
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    const p2 = b.bridge.answer(groupReq() as any, next as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sendCard).toHaveBeenCalledTimes(2); // 未放行 → 又弹卡
  });

  it("★同源保证：发起者（msg.userId=parser senderOpenId）与批准者（卡片 operator open_id）同源同值 → 命中", async () => {
    // 真实链路字段同源：入站 msg.userId = raw.sender.sender_id.open_id（parser.ts L116）；
    // 卡片点击 operatorOpenId = 事件 operator.operator_id.open_id（event-handler.ts L55）。同一 openId 空间。
    // 老板本人发起 turn（快照=ou_boss）→ 老板点卡（同值）→ Always 记住 ou_boss → 老板再触发命中
    const b = mkWithInitiator({ oc_group: "ou_boss" });
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss"); // 批准者=发起者=老板 openId
    await expect(p).resolves.toBe("allowed-once");
    const p2 = b.bridge.answer(groupReq() as any, next as any);
    await expect(p2).resolves.toBe("allowed-once"); // 同源同值 → 命中
    expect(b.sendCard).toHaveBeenCalledTimes(1);
  });

  it("★跨平台交叉（攻击场景）：企微发起者（userid）触发 → 飞书记忆里的 openId 批准者身份不命中，仍弹卡", async () => {
    // 飞书群里老板（openId）点过 Always；之后**企微**侧发起者（userid 空间）请求同工具：
    //   两身份不同源、永不相等 → 必须不命中（弹卡），而不是把企微 userid 误配到飞书 openId
    //   （此用例里两条请求都来自群聊 chatId，但发起者身份一个是 openId 一个是 userid）
    const b = mkWithInitiator({ oc_group: "wm_LiangXianSheng" }); // 本次 turn 发起者 = 企微 userid
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss"); // 批准者 = 飞书 openId（老板，isBoss 过）
    await expect(p).resolves.toBe("allowed-once");
    // 下一个 turn 换企微 userid 发起 → 与 openId 不同源永不等 → 不自动放行 → 弹卡
    const p2 = b.bridge.answer(groupReq() as any, next as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sendCard).toHaveBeenCalledTimes(2);
  });

  it("★反向交叉：企微 userid 批准记入 always → 飞书 openId 发起者不命中（双向同源隔离）", async () => {
    // 记忆按 chatId+tool 存身份集：企微 userid 与飞书 openId 混入同一 Set 时也不得互相命中。
    // 预置一条含企微 userid 的 always 记忆（模拟企微侧曾批准），飞书老板发起 → 不命中 → 弹卡
    const b = mkWithInitiator({ oc_group: "ou_boss" }); // 发起者 = 飞书 openId
    const p = b.bridge.answer(groupReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("oc_group", `approval:${entryId}:always`, "ou_boss"); // 飞书老板批准（isBoss 过）
    await expect(p).resolves.toBe("allowed-once");
    // 手动把企微 userid 混入同一 chatId+tool 的 always 身份集（模拟企微侧批准过同工具）
    const fsMod = await import("node:fs");
    const stored = JSON.parse(fsMod.readFileSync(memFile, "utf8")) as Record<string, string[]>;
    for (const v of Object.values(stored)) v.push("wm_someone"); // 混入企微 userid
    fsMod.writeFileSync(memFile, JSON.stringify(stored));
    // 新实例载入（走真实载入路径）：发起者 = 另一个企微 userid（≠ 集内任何身份）→ 不命中 → 弹卡
    const b2 = mkWithInitiator({ oc_group: "wm_other" });
    const p2 = b2.bridge.answer(groupReq() as any, next as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(b2.sendCard).toHaveBeenCalledTimes(1); // wm_other ≠ 集内任何身份 → 不自动放行 → 弹卡
  });
});

// ━━━━━━━━━━━ M6：文本审批按编号匹配（不取第一个） ━━━━━━━━━━━
describe("5b-2 · M6：文本审批按编号匹配", () => {
  function mkWecom() {
    const b = mkBridge({ platformOf: () => "wecom" as const, wecomBossUserId: "LiangXianSheng" });
    return b;
  }
  async function startWecom(b: ReturnType<typeof mkWecom>, chatId = "LiangXianSheng") {
    const p = b.bridge.answer(
      p2pReq({ agent: { id: `wecom:${chatId}:1:0` } }) as any,
      next as any,
    );
    await new Promise((r) => setTimeout(r, 0));
    // 文本审批：entryId 从发送的文本里提取（M6 后文本必须带编号）
    const sent = String(b.sendText.mock.calls.at(-1)?.[1] ?? "");
    const entryId = /编号\s*([A-Za-z0-9_]+)/.exec(sent)?.[1];
    expect(entryId).toBeDefined();
    return { p, entryId: entryId! };
  }

  it("提示文本必须带编号（M6 前提：没编号就没法精确匹配）", async () => {
    const b = mkWecom();
    await startWecom(b);
    const sent = String(b.sendText.mock.calls.at(-1)?.[1] ?? "");
    expect(sent).toContain("编号");
  });

  it("攻击场景：同一会话两条审批并存，回复 B 的编号 → 只结算 B，A 仍待处理（旧实现：取第一个必串台，必红）", async () => {
    const b = mkWecom();
    // 同一 chat 连续两个工具请求 → 两条 pending 并存（真实场景：agent 一个 turn 内连调两个危险工具）
    const a = await startWecom(b, "LiangXianSheng");
    const bb = await startWecom(b, "LiangXianSheng");
    // 回复第二个的编号 → 只结算第二个
    expect(b.bridge.onTextInbound("LiangXianSheng", `编号 ${bb.entryId} 4`, { operatorId: "LiangXianSheng", chatType: "p2p" })).toBe(true);
    await expect(bb.p).resolves.toBe("rejected");
    // 第一个仍待处理：回复它的编号 → 正常结算（证明没被误伤）
    expect(b.bridge.onTextInbound("LiangXianSheng", `编号 ${a.entryId} 1`, { operatorId: "LiangXianSheng", chatType: "p2p" })).toBe(true);
    await expect(a.p).resolves.toBe("allowed-once");
  });

  it("攻击场景：回复不存在的编号 → 不结算任何审批 + 消费留痕（fail-closed 不猜，旧实现会落到第一个 pending）", async () => {
    const b = mkWecom();
    const a = await startWecom(b);
    expect(b.bridge.onTextInbound("LiangXianSheng", "编号 a999_999 1", { operatorId: "LiangXianSheng", chatType: "p2p" })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sendText).toHaveBeenCalledWith("LiangXianSheng", expect.stringContaining("编号不匹配"));
    // A 仍待处理（没有被错误结算）
    expect(b.bridge.onTextInbound("LiangXianSheng", `编号 ${a.entryId} 4`, { operatorId: "LiangXianSheng", chatType: "p2p" })).toBe(true);
    await expect(a.p).resolves.toBe("rejected");
  });

  it("不带编号的纯数字回复 + 仅一条 pending → 兼容旧行为（唯一 pending 不串台，放行）", async () => {
    const b = mkWecom();
    const a = await startWecom(b);
    expect(b.bridge.onTextInbound("LiangXianSheng", "1", { operatorId: "LiangXianSheng", chatType: "p2p" })).toBe(true);
    await expect(a.p).resolves.toBe("allowed-once");
  });
});

// ━━━━━━━━━━━ M5：企微群聊文本审批可命中 ━━━━━━━━━━━
describe("5b-2 · M5：企微群聊文本审批", () => {
  function mkWecomGroup(bossOk = true) {
    return mkBridge({
      platformOf: () => "wecom" as const,
      wecomBossUserId: bossOk ? "LiangXianSheng" : undefined,
    });
  }
  async function startGroup(b: ReturnType<typeof mkWecomGroup>) {
    const p = b.bridge.answer(groupReq({ agent: { id: "wecom:wr_group:1:0" } }) as any, next as any);
    await new Promise((r) => setTimeout(r, 0));
    const sent = String(b.sendText.mock.calls.at(-1)?.[1] ?? "");
    const entryId = /编号\s*([A-Za-z0-9_]+)/.exec(sent)?.[1];
    expect(entryId).toBeDefined();
    return { p, entryId: entryId! };
  }

  it("攻击场景（修复目标）：群聊审批提示发出后，老板在群里回编号 → 命中并结算（旧实现：永不命中，必红）", async () => {
    const b = mkWecomGroup();
    const { p, entryId } = await startGroup(b);
    expect(b.bridge.onTextInbound("wr_group", `编号 ${entryId} 1`, { operatorId: "LiangXianSheng", chatType: "group" })).toBe(true);
    await expect(p).resolves.toBe("allowed-once");
  });

  it("攻击场景：群聊里非老板回编号 → 拒绝（fail-closed，防群成员代批）", async () => {
    const b = mkWecomGroup();
    const { p, entryId } = await startGroup(b);
    expect(b.bridge.onTextInbound("wr_group", `编号 ${entryId} 1`, { operatorId: "SomeoneElse", chatType: "group" })).toBe(true);
    await expect(p).resolves.toBe("rejected");
  });

  it("fail-closed：wecomBossUserId 未配置时群聊回编号 → 拒绝（不再整条跳过校验）", async () => {
    const b = mkWecomGroup(false);
    const { p, entryId } = await startGroup(b);
    expect(b.bridge.onTextInbound("wr_group", `编号 ${entryId} 1`, { operatorId: "LiangXianSheng", chatType: "group" })).toBe(true);
    await expect(p).resolves.toBe("rejected");
  });

  it("群聊里非决策文本 → 不消费（照常进 agent），有 pending 时提示但不结算", async () => {
    const b = mkWecomGroup();
    const { p } = await startGroup(b);
    expect(b.bridge.onTextInbound("wr_group", "大家好", { operatorId: "SomeoneElse", chatType: "group" })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.sendText).toHaveBeenCalledWith("wr_group", expect.stringContaining("请回复"));
  });
});

// ━━━━━━━━━━━ M14：记忆文件原子写 ━━━━━━━━━━━
describe("5b-2 · M14：记忆文件 tmp+rename 原子写", () => {
  it("攻击场景：persist 写入失败（rename 目标被目录占位）→ 原文件仍在且旧记忆未丢 + warn 留痕 + tmp 清理", async () => {
    // 先正常写一次，落一份好文件
    const b1 = mkBridge({});
    const p1 = b1.bridge.answer(p2pReq() as any, next as any);
    const entryId1 = entryIdOf(b1);
    b1.bridge.onCardAction("ou_boss", `approval:${entryId1}:always`, "ou_boss");
    await expect(p1).resolves.toBe("allowed-once");
    const good = readFileSync(memFile, "utf8");
    expect(Object.keys(JSON.parse(good)).length).toBe(1);

    // 第二个实例：目标路径抢先建成**目录** → writeFileSync(tmp) 成功、renameSync(tmp, dir) 抛 EISDIR/EPERM
    // （真实 I/O 失败，不靠 mock 掉病灶）→ 原文件（若有）不被覆盖、warn 留痕、tmp 清理
    const dirAsFile = join(memDir, "blocked");
    const b3 = mkBridge({ memoryFile: dirAsFile });
    mkdirSync(dirAsFile, { recursive: true }); // rename 目标是目录 → 必然失败
    const p3 = b3.bridge.answer(p2pReq({ toolName: "write" }) as any, next as any);
    const entryId3 = entryIdOf(b3);
    b3.bridge.onCardAction("ou_boss", `approval:${entryId3}:always`, "ou_boss");
    await expect(p3).resolves.toBe("allowed-once"); // 决策不受落盘失败影响
    expect(b3.logger.warn).toHaveBeenCalledWith(expect.stringContaining("审批记忆落盘失败"));
    expect(existsSync(`${dirAsFile}.tmp`)).toBe(false); // tmp 已清理
    // 原始好文件未被波及
    expect(readFileSync(memFile, "utf8")).toBe(good);
  });

  it("正常写入后：内容完整、无 tmp 残留", async () => {
    const b = mkBridge({});
    const p = b.bridge.answer(p2pReq() as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:always`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    const parsed = JSON.parse(readFileSync(memFile, "utf8")) as Record<string, string[]>;
    expect(Object.keys(parsed).length).toBe(1);
    const [, ids] = Object.entries(parsed)[0]!;
    expect(ids).toContain("ou_boss");
    expect(existsSync(`${memFile}.tmp`)).toBe(false);
  });
});

// ━━━━━━━━━━━ M42：settle 后清理定时器与监听 ━━━━━━━━━━━
describe("5b-2 · M42：settle 后定时器/监听清理", () => {
  it("决策收口后：advance 超时不再触发二次 settle（日志无重复结算），abort 事件不再被消费", async () => {
    vi.useFakeTimers();
    try {
      const b = mkBridge({ timeoutMs: 5_000 });
      const p = b.bridge.answer(p2pReq() as any, next as any);
      const entryId = entryIdOf(b);
      b.bridge.onCardAction("ou_boss", `approval:${entryId}:allow-once`, "ou_boss");
      await expect(p).resolves.toBe("allowed-once");
      const warns = b.logger.warn.mock.calls.length;
      // 推进超过原超时窗口：若 timer 未清，settle 会再次走终态刷写（幂等挡 outcome，但资源白占 + 多一次刷卡）
      await vi.advanceTimersByTimeAsync(10_000);
      expect(b.updateCard.mock.calls.length).toBe(1); // 只有决策那一次收口刷卡，超时没多刷
      expect(b.logger.warn.mock.calls.length).toBe(warns);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort 路径：settle（点击决策）后 signal 再 abort → 不影响已收口结果，无二次刷卡", async () => {
    const ac = new AbortController();
    const b = mkBridge({ timeoutMs: 60_000 });
    const p = b.bridge.answer(p2pReq({ signal: ac.signal }) as any, next as any);
    const entryId = entryIdOf(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:allow-once`, "ou_boss");
    await expect(p).resolves.toBe("allowed-once");
    ac.abort(); // 若监听未摘，会触发 settle("cancelled")——被 settled 幂等挡住，但监听本身该被摘除
    await new Promise((r) => setTimeout(r, 0));
    expect(b.updateCard.mock.calls.length).toBe(1);
    await expect(p).resolves.toBe("allowed-once"); // 结果不被 abort 改写
  });
});

// ━━━━━━━━━━━ buildApprovalText 编号格式锚 ━━━━━━━━━━━
describe("5b-2 · 审批文本格式", () => {
  it("buildApprovalText 含编号行（供 onTextInbound 精确匹配）", () => {
    const t = buildApprovalText({ entryId: "a1_2", toolName: "bash" });
    expect(t).toContain("编号 a1_2");
    expect(t).toContain("1 = ✅ 允许一次");
  });
});
