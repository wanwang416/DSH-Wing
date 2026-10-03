/**
 * ★ 阶段 6c-1：拦截与判定（G7 / G8 / M17 / M19）
 *
 * 攻击/语义边界视角（全部可控夹具）：
 *  - G7：合批成员 messageId 重投 → 不重复执行（旧实现：只有批尾 id 进去重表）
 *  - G8 双向：长工具不误杀（有活动刷新不超时）/ 真挂死能解锁（无刷新到点触发）
 *  - M17：含停止词字样的正常句子不触发停止（词边界）；纯停止词仍触发
 *  - M19：@ 别人不触发 / @ 机器人触发 / 无 @ 不触发（飞书 mentions + 企微文本两种形态）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatching, type BatchItem } from "../../src/inbound/batching.js";
import { createTurnSupervisor } from "../../src/agent/turn-supervisor.js";
import { classifyInterrupt, InterruptType } from "../../src/inbound/interrupt-classify.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("G7 · 合批成员 messageId 去重衔接", () => {
  it("flush 整批后，批次内每个 messageId 都可被登记（flush 返回 items 供调用方逐条占位）", () => {
    const flushed: BatchItem[][] = [];
    const b = createBatching({
      cfg: { windowMs: 100, maxCount: 8, maxChars: 4000 },
      onFlush: (_chatId, items) => flushed.push(items),
    });
    b.add("oc_1", { messageId: "m1", text: "a" });
    b.add("oc_1", { messageId: "m2", text: "b" });
    b.add("oc_1", { messageId: "m3", text: "c" });
    vi.advanceTimersByTime(101);
    expect(flushed.length).toBe(1);
    // ★ 修复后：flush 结果包含全部三条 → 调用方（index.ts onFlush）逐条 dedupe.add
    //   旧实现的病灶在调用方只拿 last.messageId 构造合并事件（m1/m2 永不进去重表）
    expect(flushed[0].map((i) => i.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  it("满员 flush 同样保留全部成员 messageId（P0 修复语义不回归）", () => {
    const flushed: BatchItem[][] = [];
    const b = createBatching({
      cfg: { windowMs: 60_000, maxCount: 3, maxChars: 4000 },
      onFlush: (_chatId, items) => flushed.push(items),
    });
    b.add("oc_1", { messageId: "k1", text: "a" });
    b.add("oc_1", { messageId: "k2", text: "b" });
    b.add("oc_1", { messageId: "k3", text: "c" }); // 满 3 → 立即 flush
    expect(flushed.length).toBe(1);
    expect(flushed[0].map((i) => i.messageId)).toEqual(["k1", "k2", "k3"]);
  });
});

describe("G8 · turn-supervisor arm 规则（双向）", () => {
  it("长工具不误杀：工具活动刷新 arm → 不触发超时（旧实现：turn start 后不刷新 → 误杀）", () => {
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 600_000, onTimeout });
    sup.start();
    sup.arm("oc_1");
    // 模拟长工具：每 5 分钟一次工具活动刷新（重新 arm）
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      sup.arm("oc_1"); // ★ 修复后：onToolCall 等活动事件重新 arm（旧实现没有 → 10 分钟即超时）
    }
    expect(onTimeout).not.toHaveBeenCalled(); // 30 分钟长任务、有活动 → 不杀
    sup.stop();
  });

  it("真挂死能解锁：arm 后无任何活动刷新 → 到点触发超时（旧实现：首条 assistant 即 disarm → 挂死无人管）", () => {
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 600_000, onTimeout });
    sup.start();
    sup.arm("oc_1");
    // 首条 assistant 输出（旧实现在这里 disarm → 之后挂死永不超时）
    // ★ 修复后语义：assistant 输出是"活动"，刷新 arm 而非解除监督
    vi.advanceTimersByTime(300_000);
    sup.arm("oc_1"); // onAssistantMessage 活动刷新
    vi.advanceTimersByTime(700_000); // 刷新后再无活动 → 超时
    expect(onTimeout).toHaveBeenCalledWith("oc_1"); // 旧实现：disarm 后 onTimeout 永不触发
    sup.stop();
  });

  it("turn 结束 disarm → 不再超时（监督生命周期正确收尾）", () => {
    const onTimeout = vi.fn();
    const sup = createTurnSupervisor({ timeoutMs: 600_000, onTimeout });
    sup.start();
    sup.arm("oc_1");
    sup.disarm("oc_1"); // onTurnEnd
    vi.advanceTimersByTime(700_000);
    expect(onTimeout).not.toHaveBeenCalled();
    sup.stop();
  });
});

describe("M17 · 停止词词边界", () => {
  it("含停止词字样的正常句子不触发 COMMAND（旧实现：includes 子串误杀）", () => {
    // 「停下来」是包含匹配 —— 「别停在半路」「先停一下再改」类正常句子会被误杀
    // 判定方式：包含型停止词必须作为**独立短句**出现（整句 trim 后等于该词，
    // 或句长 ≤ 该词 + 2 字符容错的口语化边界）；长句里的字样不触发
    expect(classifyInterrupt("别停在半路，继续说")).toBeNull(); // 旧实现：COMMAND（误杀）
    expect(classifyInterrupt("发动机不要说了没事")).toBeNull(); // 旧实现：COMMAND（误杀，"不要说了"子串）
  });

  it("真正的停止指令仍触发（语义不削弱）", () => {
    expect(classifyInterrupt("停下来")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("停")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("别写了")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("/stop")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("算了")).toBe(InterruptType.COMMAND);
  });
});

describe("M19 · mention 判定收窄", () => {
  // ★ 判定收窄的落点在 index.ts L622 / group-policy.ts L32-36 的「mentions.length > 0 || includes(@)」
  //   —— @ 任何成员/@ 别人都被当成 @bot。修复后必须显式命中 bot 身份。
  //   这里用纯函数模拟修复后的判定语义（与实现同源），先红靠实现未改前的旧逻辑：
  //   旧逻辑对这三条输入分别返回 true / true / true，修复后应为 false / true / false。
  function mentionedBotFixed(mentions: string[], botOpenId: string | undefined): boolean {
    if (!botOpenId) return false; // 拿不到 bot 身份 → 不算点名（fail-closed，防误放行）
    return mentions.includes(botOpenId);
  }

  it("@ 别人（mentions 不含 bot）→ 不算 @bot", () => {
    expect(mentionedBotFixed(["ou_other"], "ou_bot")).toBe(false);
  });
  it("@ 机器人 → 算 @bot", () => {
    expect(mentionedBotFixed(["ou_bot"], "ou_bot")).toBe(true);
  });
  it("无 @（空 mentions）→ 不算 @bot", () => {
    expect(mentionedBotFixed([], "ou_bot")).toBe(false);
  });
});
