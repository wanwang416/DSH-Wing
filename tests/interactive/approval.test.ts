/**
 * P1-1 审批卡测试（四按钮回调 + 记忆 + 老板限定 ALAN 拍板④）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalBridge, buildApprovalCard, buildApprovalSettledCard, chatIdFromAgentId } from "../../src/interactive/approval.js";
import { messageIdOfRes } from "../../src/agent/user-questions.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wing-approval-"));
  return join(dir, "approval-memory.json");
}
let memFile: string;
beforeEach(() => { memFile = tmpFile(); });
afterEach(() => { rmSync(dirnameOf(memFile), { recursive: true, force: true }); });
function dirnameOf(p: string): string { return p.slice(0, p.lastIndexOf("/") === -1 ? p.lastIndexOf("\\") : p.lastIndexOf("/")) || "."; }

const req = (over: Record<string, unknown> = {}) => ({
  agent: { id: "feishu:oc_1:1:0" },
  toolName: "bash",
  reason: "运行危险命令",
  ...over,
});
const next = vi.fn(async () => "unavailable" as const);

function mkBridge(over: Record<string, unknown> = {}) {
  // Bug3b：sendCard 须 resolve 返回 message_id（sender.sendCard 直发 → messageIdOf 提取）；updateCard 供收口断言
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

describe("buildApprovalCard", () => {
  it("四按钮 + op 格式 approval:<entryId>:<decision>", () => {
    const card = buildApprovalCard({ entryId: "a1_123", toolName: "bash", reason: "危险" });
    expect(card.schema).toBe("2.0");
    expect((card.header as any).title.content).toBe("🔓 操作审批");
    const els = (card.body as any).elements as any[];
    expect(els[0].tag).toBe("markdown");
    expect(els[0].content).toContain("bash");
    expect(els[0].content).toContain("危险");
    const buttons = els.slice(1) as any[];
    expect(buttons).toHaveLength(4);
    expect(buttons[0].behaviors[0].value.op).toBe("approval:a1_123:allow-once");
    expect(buttons[1].behaviors[0].value.op).toBe("approval:a1_123:session");
    expect(buttons[2].behaviors[0].value.op).toBe("approval:a1_123:always");
    expect(buttons[3].behaviors[0].value.op).toBe("approval:a1_123:deny");
    // deny 用 danger 红
    expect(buttons[3].type).toBe("danger");
  });

  it("配置 bossOpenId → 卡片说明带「仅限老板」", () => {
    const card = buildApprovalCard({ entryId: "a1", toolName: "bash", bossOpenId: "ou_1" });
    const content = (card.body as any).elements[0].content as string;
    expect(content).toContain("仅限老板本人操作");
  });
});

describe("chatIdFromAgentId", () => {
  it("feishu 前缀 → 反推 chatId", () => {
    expect(chatIdFromAgentId("feishu:oc_123:5:0")).toBe("oc_123");
  });
  it("非本插件前缀 → undefined", () => {
    expect(chatIdFromAgentId("other:oc_1:0")).toBeUndefined();
  });
});

describe("approval answer（waterfall）", () => {
  it("非本插件 agent → next()，不发卡", async () => {
    const { bridge, sendCard } = mkBridge();
    const outcome = await bridge.answer({ ...req(), agent: { id: "web:abc:0" } } as any, next as any);
    expect(next).toHaveBeenCalled();
    expect(outcome).toBe("unavailable");
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("无记忆 → 发卡 + 等用户决策", async () => {
    const { bridge, sendCard } = mkBridge();
    const p = bridge.answer(req() as any, next as any);
    // 发卡立即发生
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledWith("oc_1", expect.objectContaining({ schema: "2.0" }));
    // 未决策 → promise 未 settle
    let settled = false;
    p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it("Always 记忆命中 → 直接 allowed-once，不发卡", async () => {
    const { bridge, sendCard } = mkBridge();
    // 先建立 always 记忆（走一次 always 决策）
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    expect(entryId).toBeDefined();
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:always`, "ou_1");
    expect(consumed).toBe(true);
    expect(await p).toBe("allowed-once");
    // 再次请求同 chat+tool → 不发卡直接放行
    sendCard.mockClear();
    const p2 = bridge.answer(req() as any, next as any);
    expect(sendCard).not.toHaveBeenCalled();
    expect(await p2).toBe("allowed-once");
  });

  it("Session 记忆命中 → 本会话同 tool 直接放行", async () => {
    const { bridge, sendCard } = mkBridge();
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    bridge.onCardAction("oc_1", `approval:${entryId}:session`, "ou_1");
    expect(await p).toBe("allowed-once");
    sendCard.mockClear();
    const p2 = bridge.answer(req() as any, next as any);
    expect(sendCard).not.toHaveBeenCalled();
    expect(await p2).toBe("allowed-once");
    // 换 chat → 仍弹卡（session 记忆按 chat 隔离）
    sendCard.mockClear();
    const p3 = bridge.answer({ ...req(), agent: { id: "feishu:oc_2:1:0" } } as any, next as any);
    expect(sendCard).toHaveBeenCalledTimes(1);
    const entryId2 = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    bridge.onCardAction("oc_2", `approval:${entryId2}:allow-once`, "ou_1");
    expect(await p3).toBe("allowed-once");
  });

  it("超时 → cancelled（fail-closed）", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = mkBridge();
      const p = bridge.answer(req() as any, next as any);
      vi.advanceTimersByTime(1500);
      expect(await p).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("signal abort → cancelled", async () => {
    const ac = new AbortController();
    const { bridge, sendCard } = mkBridge();
    const p = bridge.answer({ ...req(), signal: ac.signal } as any, next as any);
    ac.abort();
    expect(await p).toBe("cancelled");
  });

  it("发卡抛错 → unavailable（fail-closed）", async () => {
    const throwing = vi.fn(() => { throw new Error("send boom"); });
    const { bridge } = mkBridge({ sendCard: throwing });
    const outcome = await bridge.answer(req() as any, next as any);
    expect(outcome).toBe("unavailable");
  });
});

describe("onCardAction（四按钮 + 老板限定）", () => {
  it("allow-once → resolve allowed-once（仅本次）", async () => {
    const { bridge, sendCard } = mkBridge({ bossOpenId: "ou_boss" });
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:allow-once`, "ou_boss");
    expect(consumed).toBe(true);
    expect(await p).toBe("allowed-once");
  });

  it("deny → rejected（agent 收到拒绝）", async () => {
    const { bridge, sendCard } = mkBridge({ bossOpenId: "ou_boss" });
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:deny`, "ou_boss");
    expect(consumed).toBe(true);
    expect(await p).toBe("rejected");
  });

  it("非老板点击 → 拦截 + 拒绝 + 回执提示（拍板④）", async () => {
    const { bridge, sendCard, sendText } = mkBridge({ bossOpenId: "ou_boss" });
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:allow-once`, "ou_evil");
    expect(consumed).toBe(true);
    expect(await p).toBe("rejected"); // fail-closed
    expect(sendText).toHaveBeenCalledWith("oc_1", expect.stringContaining("仅限老板本人操作"));
  });

  it("未配置 bossOpenId → 不拦截（单用户宽松）+ warn 一次", async () => {
    const { bridge, sendCard, logger } = mkBridge(); // 无 bossOpenId
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:allow-once`, "ou_anyone");
    expect(consumed).toBe(true);
    expect(await p).toBe("allowed-once");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("bossOpenId"));
  });

  it("entry 不存在 / chatId 不匹配 → false（不消费）", () => {
    const { bridge } = mkBridge();
    expect(bridge.onCardAction("oc_1", "approval:nope:allow-once", "ou_1")).toBe(false);
    expect(bridge.onCardAction("oc_9", "approval:whatever:allow-once", "ou_1")).toBe(false);
  });

  it("未知 decision → false", async () => {
    const { bridge, sendCard } = mkBridge();
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    const consumed = bridge.onCardAction("oc_1", `approval:${entryId}:maybe`, "ou_1");
    expect(consumed).toBe(false);
    expect(await p).toBe("cancelled"); // 超时兜底（decision 不认领，pending 仍在）
  });

  it("always 决策 → 落盘 JSON（重启恢复）", async () => {
    const { bridge, sendCard } = mkBridge();
    const p = bridge.answer(req() as any, next as any);
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    bridge.onCardAction("oc_1", `approval:${entryId}:always`, "ou_1");
    expect(await p).toBe("allowed-once");
    expect(existsSync(memFile)).toBe(true);
    const raw = JSON.parse(readFileSync(memFile, "utf8"));
    expect(raw["oc_1:bash"]).toContain("bash");
  });
});

describe("Bug3b：决策后收口换状态卡（不再停留可操作界面）", () => {
  // flush 让 sendCard(mockResolvedValue) 的 .then 捕获 message_id（真实场景用户点击远晚于发送，天然满足）
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("allow-once → 卡替换成「✅ 已允许」状态卡", async () => {
    const { bridge, sendCard, updateCard } = mkBridge({ bossOpenId: "ou_boss" });
    const p = bridge.answer(req() as any, next as any);
    await flush();
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    expect(entryId).toBeDefined();
    expect(bridge.onCardAction("oc_1", `approval:${entryId}:allow-once`, "ou_boss")).toBe(true);
    expect(await p).toBe("allowed-once");
    // 收口：以已捕获的 message_id + 状态卡 JSON 调 updateCard
    expect(updateCard).toHaveBeenCalledTimes(1);
    const [msgId, cardJson] = updateCard.mock.calls[0] as [string, string];
    expect(msgId).toBe("om_msg");
    const card = JSON.parse(cardJson);
    expect((card.header as any).template).toBe("green");
    expect((card.header as any).title.content).toContain("已允许");
    expect((card.body as any).elements[0].content).toContain("bash");
  });

  it("deny → 卡替换成「❌ 已拒绝」状态卡", async () => {
    const { bridge, sendCard, updateCard } = mkBridge({ bossOpenId: "ou_boss" });
    const p = bridge.answer(req() as any, next as any);
    await flush();
    const entryId = /approval:(a\d+_\d+)/.exec(JSON.stringify(sendCard.mock.calls[0][1]) ?? "")?.[1];
    expect(bridge.onCardAction("oc_1", `approval:${entryId}:deny`, "ou_boss")).toBe(true);
    expect(await p).toBe("rejected");
    expect(updateCard).toHaveBeenCalledTimes(1);
    const [, cardJson] = updateCard.mock.calls[0] as [string, string];
    const card = JSON.parse(cardJson);
    expect((card.header as any).template).toBe("red");
    expect((card.header as any).title.content).toContain("已拒绝");
  });

  it("signal abort → 卡替换成「⏰ 已失效」状态卡", async () => {
    const ac = new AbortController();
    const { bridge, sendCard, updateCard } = mkBridge();
    const p = bridge.answer({ ...req(), signal: ac.signal } as any, next as any);
    await flush();
    ac.abort();
    expect(await p).toBe("cancelled");
    expect(updateCard).toHaveBeenCalledTimes(1);
    const [, cardJson] = updateCard.mock.calls[0] as [string, string];
    const card = JSON.parse(cardJson);
    expect((card.header as any).template).toBe("grey");
    expect((card.header as any).title.content).toContain("已失效");
  });
});

describe("buildApprovalSettledCard（纯函数）", () => {
  it("allowed-once → ✅ 已允许 / green", () => {
    const c = buildApprovalSettledCard({ toolName: "bash", outcome: "allowed-once" });
    expect((c.header as any).template).toBe("green");
    expect((c.header as any).title.content).toContain("已允许");
  });
  it("rejected → ❌ 已拒绝 / red", () => {
    const c = buildApprovalSettledCard({ toolName: "bash", outcome: "rejected" });
    expect((c.header as any).template).toBe("red");
    expect((c.header as any).title.content).toContain("已拒绝");
  });
  it("cancelled → ⏰ 已失效 / grey", () => {
    const c = buildApprovalSettledCard({ toolName: "bash", outcome: "cancelled" });
    expect((c.header as any).template).toBe("grey");
    expect((c.header as any).title.content).toContain("已失效");
  });
  it("unavailable → ⚠️ 发送失败 / red", () => {
    const c = buildApprovalSettledCard({ toolName: "bash", outcome: "unavailable" });
    expect((c.header as any).template).toBe("red");
    expect((c.header as any).title.content).toContain("发送失败");
  });
  it("收口卡无按钮（body 仅一条 markdown）", () => {
    const c = buildApprovalSettledCard({ toolName: "bash", outcome: "allowed-once" });
    const els = (c.body as any).elements as any[];
    expect(els).toHaveLength(1);
    expect(els[0].tag).toBe("markdown");
  });
});
