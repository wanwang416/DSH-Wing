/**
 * 阶段 3 · B1/C1 回归测试（G2 所有 reason 收尾 / M7 streams.delete 身份校验）
 * 先红依据：
 *  - G2：旧 onTurnEnd 只在 completed && finalAnswer 时 finalizeToNewCard；aborted/error/max-tokens
 *        分支对过程卡不做任何动作 → 卡片 header 永远 "Working…"、CardKit 流式态永不关闭。
 *  - M7：旧 onTurnEnd 末尾无条件 streams.delete(chatId)；若收尾网络往返期间 onTurnStart 已换新 state，
 *        新轮次的卡会被整段删掉 → 整轮无过程卡。
 */
import { describe, expect, it, vi } from "vitest";
import { createExperience } from "../../src/agent/experience.js";

function makeDeps(over: Partial<ConstructorParameters<typeof createExperience>[0]> = {}) {
  return {
    createStreamCard: vi.fn().mockReturnValue({
      addThinking: vi.fn().mockResolvedValue(undefined),
      addText: vi.fn().mockResolvedValue(undefined),
      addTool: vi.fn().mockResolvedValue(undefined),
      setToolResult: vi.fn().mockResolvedValue(undefined),
      addContext: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(undefined),
      finalizeToNewCard: vi.fn().mockResolvedValue(true),
      latestAnswer: "",
      cardId: "c1",
    }),
    sendText: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    followup: vi.fn(),
    cfg: () => ({ reactions: { enabled: false }, steerDiagLogPath: "" }) as never,
    turnSupervisor: { arm: vi.fn(), disarm: vi.fn(), isOverdue: () => false },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  } as unknown as ConstructorParameters<typeof createExperience>[0];
}

describe("阶段3 B1/C1：会话收尾", () => {
  it("G2：reason=aborted → 过程卡被收尾（finalizeToNewCard 收到「已停止」说明）", async () => {
    const deps = makeDeps();
    const exp = createExperience(deps);
    exp.onTurnStart("chat1");
    await exp.onTurnEnd("chat1", "aborted");
    const card = deps.createStreamCard.mock.results[0].value;
    // 实现选型：收尾走 finalizeToNewCard（与 completed 同一条发送路径），而非死方法 finalize
    expect(card.finalizeToNewCard).toHaveBeenCalledWith(expect.stringContaining("已停止"));
  });

  it("G2：reason=error → 过程卡被收尾（finalizeToNewCard 收到出错说明）", async () => {
    const deps = makeDeps();
    const exp = createExperience(deps);
    exp.onTurnStart("chat1");
    await exp.onTurnEnd("chat1", "error");
    const card = deps.createStreamCard.mock.results[0].value;
    expect(card.finalizeToNewCard).toHaveBeenCalledWith(expect.stringContaining("已结束"));
  });

  it("G2：reason=completed 但无正文 → 也收尾（不触发结果卡，但卡片流式态要关闭）", async () => {
    const deps = makeDeps();
    const exp = createExperience(deps);
    exp.onTurnStart("chat1");
    await exp.onTurnEnd("chat1", "completed");
    const card = deps.createStreamCard.mock.results[0].value;
    expect(card.finalizeToNewCard).toHaveBeenCalledWith(expect.stringContaining("已结束"));
  });

  it("G2：completed + 正文 → 仍走结果卡 finalizeToNewCard（现状保留）", async () => {
    const deps = makeDeps();
    const exp = createExperience(deps);
    exp.onTurnStart("chat1");
    await exp.onAssistantMessage("chat1", "最终答案");
    await exp.onTurnEnd("chat1", "completed");
    const card = deps.createStreamCard.mock.results[0].value;
    expect(card.finalizeToNewCard).toHaveBeenCalledWith("最终答案");
  });

  it("M7：onTurnEnd 收尾期间 onTurnStart 换了新 state → 只删自己的 state（新轮次不受影响）", async () => {
    // 用慢 finalizeToNewCard 模拟网络往返窗口
    let resolveFin: (v: boolean) => void = () => void 0;
    const slowCard = {
      addThinking: vi.fn().mockResolvedValue(undefined),
      addText: vi.fn().mockResolvedValue(undefined),
      addTool: vi.fn().mockResolvedValue(undefined),
      setToolResult: vi.fn().mockResolvedValue(undefined),
      addContext: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(undefined),
      finalizeToNewCard: vi.fn().mockImplementation(() => new Promise<boolean>((r) => (resolveFin = r))),
      latestAnswer: "",
      cardId: "c1",
    };
    const firstCard = { ...slowCard };
    const deps = makeDeps({
      createStreamCard: vi
        .fn()
        .mockReturnValueOnce(firstCard)
        .mockReturnValueOnce({ ...slowCard, finalizeToNewCard: vi.fn().mockResolvedValue(true) }),
    });
    const exp = createExperience(deps);
    exp.onTurnStart("chat1"); // 第一轮
    await exp.onAssistantMessage("chat1", "第一轮答案");
    const endPromise = exp.onTurnEnd("chat1", "completed"); // 收尾中（卡在网络往返）
    exp.onTurnStart("chat1"); // 新一轮开始（state 被替换）
    resolveFin(true);
    await endPromise;
    // 新一轮的 card 必须还在（旧实现 streams.delete 无校验会把它删掉）
    exp.onChunk("chat1", "新轮次的第一个字");
    const newCard = deps.createStreamCard.mock.results[1].value;
    expect(newCard.addText).toHaveBeenCalledWith("新轮次的第一个字");
  });
});
