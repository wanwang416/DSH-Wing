/**
 * ★ 阶段 5b-1 攻击场景回归（G6 / M15 / M16，2026-10-02）
 *
 * 攻击者视角：
 *  - G6：老板批准过"永久允许"后，非老板在同会话用同工具 → 仍必须弹审批（记忆绑定批准者）
 *  - M15：bossOpenId / wecomBossUserId 未配置 → 审批点击一律拒绝（fail-closed）
 *  - M16：先 settle、后发卡完成 → 卡片最终仍被刷成终态（不永久停在"待处理"）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalBridge } from "../../src/interactive/approval.js";
import { messageIdOfRes } from "../../src/agent/user-questions.js";

const req = (over: Record<string, unknown> = {}) => ({
  // ★ G6 最严口径的现实对齐：p2p 会话 chatId ≡ 发起者 openId（parser 保证）。
  //   老板的会话 chatId = "ou_boss" → 老板发起请求、老板批准（ou_boss）→ 身份一致才命中记忆。
  agent: { id: "feishu:ou_boss:1:0" },
  toolName: "bash",
  reason: "运行危险命令",
  ...over,
});
const next = vi.fn(async () => "unavailable" as const);

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/") === -1 ? p.lastIndexOf("\\") : p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}
let memFile: string;
let memDir: string;
beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "wing-approval-5b-"));
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
    timeoutMs: 1000,
    logger,
    ...over,
  } as any);
  return { bridge, sendCard, updateCard, sendText, logger };
}

/** 走一次 answer → 提取 entryId（发卡 JSON 里） */
async function startApproval(b: ReturnType<typeof mkBridge>, bossOpenId = "ou_boss") {
  const p = b.bridge.answer(req() as any, next as any);
  const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls[0][1]) ?? "")?.[1];
  expect(entryId).toBeDefined();
  return { p, entryId: entryId!, operatorOpenId: bossOpenId };
}

describe("5b-1 · G6：记忆绑定批准者身份", () => {
  it("攻击场景（群聊）：老板批准 always 后，其他成员触发同工具 → 仍弹审批（旧实现：免审批直接放行，必红）", async () => {
    // 群聊：chatId=oc_group（≠任何成员 openId）→ answer 身份线索不可靠 → 记忆永不自动放行（fail-closed）
    const b = mkBridge({ bossOpenId: "ou_boss" });
    const gp = b.bridge.answer({ ...req(), agent: { id: "feishu:oc_group:1:0" } } as any, next as any);
    const gEntry = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls[0][1]) ?? "")?.[1]!;
    b.bridge.onCardAction("oc_group", `approval:${gEntry}:always`, "ou_boss");
    expect(await gp).toBe("allowed-once");
    // ★ 攻击：之后任何人（含身份未知者）在同群触发同工具 → 必须重新弹审批，不许命中记忆
    b.sendCard.mockClear();
    const p3 = b.bridge.answer({ ...req(), agent: { id: "feishu:oc_group:2:0" } } as any, next as any);
    expect(b.sendCard).toHaveBeenCalledTimes(1); // 旧实现：0 次（记忆命中直接放行）
    const entryId3 = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls[0][1]) ?? "")?.[1]!;
    b.bridge.onCardAction("oc_group", `approval:${entryId3}:deny`, "ou_evil");
    expect(await p3).toBe("rejected");
  });

  it("p2p（chatId≡归属者）：老板批准 always → 老板自己后续请求免审批；落盘含批准者身份", async () => {
    const b = mkBridge({ bossOpenId: "ou_boss" });
    const { p, entryId } = await startApproval(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:always`, "ou_boss");
    expect(await p).toBe("allowed-once");
    const raw = JSON.parse(readFileSync(memFile, "utf8"));
    expect(JSON.stringify(raw)).toContain("ou_boss"); // 批准者身份落盘
    // 老板自己再触发（同 p2p，chatId≡ou_boss）→ 记忆命中，免审批
    b.sendCard.mockClear();
    const p2 = b.bridge.answer(req() as any, next as any);
    expect(b.sendCard).not.toHaveBeenCalled();
    expect(await p2).toBe("allowed-once");
  });

  it("session 记忆同样绑定批准者：群聊里老板批 session，后续请求仍弹卡", async () => {
    const b = mkBridge({ bossOpenId: "ou_boss" });
    const gp = b.bridge.answer({ ...req(), agent: { id: "feishu:oc_group:1:0" } } as any, next as any);
    const gEntry = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls[0][1]) ?? "")?.[1]!;
    b.bridge.onCardAction("oc_group", `approval:${gEntry}:session`, "ou_boss");
    expect(await gp).toBe("allowed-once");
    b.sendCard.mockClear();
    const p2 = b.bridge.answer({ ...req(), agent: { id: "feishu:oc_group:2:0" } } as any, next as any);
    expect(b.sendCard).toHaveBeenCalledTimes(1); // session 记忆绑定批准者，群聊不自动放行
    const entryId2 = /approval:(a\d+_\d+)/.exec(JSON.stringify(b.sendCard.mock.calls[0][1]) ?? "")?.[1]!;
    b.bridge.onCardAction("oc_group", `approval:${entryId2}:deny`, "ou_evil");
    expect(await p2).toBe("rejected");
  });
});

describe("5b-1 · M15：未配置 boss 字段 → fail-closed", () => {
  it("攻击场景：未配置 bossOpenId 时点审批卡片 → 拒绝（旧实现：恒放行，必红）", async () => {
    const b = mkBridge({}); // 无 bossOpenId
    const { p, entryId } = await startApproval(b, "ou_anyone");
    const consumed = b.bridge.onCardAction("ou_boss", `approval:${entryId}:allow-once`, "ou_anyone");
    expect(consumed).toBe(true);
    expect(await p).toBe("rejected"); // 旧实现 allowed-once
    expect(b.sendText).toHaveBeenCalledWith("ou_boss", expect.stringContaining("未配置老板身份"));
  });

  it("攻击场景：未配置 wecomBossUserId 时企微文本审批 → 拒绝（旧实现：整条跳过校验，必红）", async () => {
    const b = mkBridge({ platformOf: () => "wecom" }); // 无 wecomBossUserId
    // 企微走文本模式：answer 不发卡，发文本
    const p = b.bridge.answer(req() as any, next as any);
    await new Promise((r) => setTimeout(r, 10));
    // 文本回复决策（operatorId 有了但 boss 字段没配 → fail-closed）
    const consumed = b.bridge.onTextInbound("ou_boss", "1", { operatorId: "wemm_user", chatType: "p2p" });
    expect(consumed).toBe(true);
    expect(await p).toBe("rejected");
    expect(b.sendText).toHaveBeenCalledWith("ou_boss", expect.stringContaining("未配置老板身份"));
  });

  it("warn 每次都打（不是 once）：连续两次拒绝，两次都有留痕", async () => {
    const b = mkBridge({}); // 无 bossOpenId
    const { p, entryId } = await startApproval(b, "ou_anyone");
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:deny`, "ou_anyone");
    await p;
    b.sendCard.mockClear(); // ★ 保证第二次 startApproval 取到新 entryId
    const { p: p2, entryId: e2 } = await startApproval(b, "ou_anyone");
    b.bridge.onCardAction("ou_boss", `approval:${e2}:deny`, "ou_anyone");
    await p2;
    const warns = b.logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    const bossWarns = warns.filter((w) => w.includes("未配置老板身份"));
    expect(bossWarns.length).toBeGreaterThanOrEqual(2);
  });

  it("配置齐全 + 老板本人 → 正常放行（防误伤锚）", async () => {
    const b = mkBridge({ bossOpenId: "ou_boss" });
    const { p, entryId } = await startApproval(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:allow-once`, "ou_boss");
    expect(await p).toBe("allowed-once");
  });
});

describe("5b-1 · M16：settle 与发卡完成竞态", () => {
  it("竞态攻击：先 settle（秒点超时）、后发卡完成 → 卡片最终仍刷成终态（旧实现：停在待处理，必红）", async () => {
    let resolveSend!: (v: unknown) => void;
    const b = mkBridge();
    // 让 sendCard 挂起（模拟网络慢）——此时用户"秒点"不可能，但超时可先触发
    b.sendCard.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    const p = b.bridge.answer({ ...req(), signal: undefined } as any, next as any);
    // 发卡还没 resolve → sentCardMessageId 尚未回填；让超时先 settle
    await vi.waitFor(() => expect(b.updateCard).toHaveBeenCalled(), { timeout: 3000 }).catch(() => void 0);
    // 旧实现：settle 时 sentCardMessageId 为空 → updateCard 永不被调
    // 此处不能等 1s 超时——用 timeoutMs=1000 的真实钟，先等 30ms 再 resolve 发卡
    await new Promise((r) => setTimeout(r, 30));
    resolveSend({ data: { message_id: "om_late" } }); // 发卡完成（settle 之后）
    await p; // cancelled（超时）
    // 修复后：settle 应等待/补发终态更新 → updateCard 必须被调
    await vi.waitFor(() => {
      expect(b.updateCard).toHaveBeenCalledWith("om_late", expect.any(String));
    }, { timeout: 2000 });
    const cardJson = JSON.stringify(b.updateCard.mock.calls[0][1]);
    expect(cardJson).toContain("已失效"); // cancelled 终态
  });

  it("正常路径：发卡完成后再决策 → 卡刷成终态（防回归锚）", async () => {
    const b = mkBridge();
    const { p, entryId } = await startApproval(b);
    b.bridge.onCardAction("ou_boss", `approval:${entryId}:allow-once`, "ou_boss");
    await p;
    expect(b.updateCard).toHaveBeenCalledWith("om_msg", expect.any(String));
  });
});
