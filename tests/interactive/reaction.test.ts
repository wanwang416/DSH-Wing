import { describe, expect, it, vi } from "vitest";
import { createReactionManager } from "../../src/interactive/reaction.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    enabled: () => true,
    ...(overrides as any),
  };
}

describe("createReactionManager", () => {
  it("react：disabled → undefined 且不调 addReaction", async () => {
    const d = deps({ enabled: () => false });
    const r = createReactionManager(d);
    expect(await r.react("om_1", "THUMBSUP")).toBeUndefined();
    expect(d.addReaction).not.toHaveBeenCalled();
  });

  it("react：data.reaction_id → 返回 + 缓存", async () => {
    const d = deps({ addReaction: vi.fn().mockResolvedValue({ data: { reaction_id: "re_1" } }) });
    const r = createReactionManager(d);
    expect(await r.react("om_1", "OK")).toBe("re_1");
    expect(d.addReaction).toHaveBeenCalledWith("om_1", "OK");
  });

  it("react：顶层 reaction_id → 返回", async () => {
    const d = deps({ addReaction: vi.fn().mockResolvedValue({ reaction_id: "re_2" }) });
    const r = createReactionManager(d);
    expect(await r.react("om_1", "OK")).toBe("re_2");
  });

  it("react：addReaction 抛错 → 静默忽略返回 undefined", async () => {
    const d = deps({ addReaction: vi.fn().mockRejectedValue(new Error("231001")) });
    const r = createReactionManager(d);
    expect(await r.react("om_1", "WOW")).toBeUndefined();
  });

  it("clear：有 reactionId + removeReaction → 调用删除", async () => {
    const d = deps({ addReaction: vi.fn().mockResolvedValue({ data: { reaction_id: "re_3" } }) });
    const r = createReactionManager(d);
    await r.react("om_1", "HEART");
    await r.clear("om_1");
    expect(d.removeReaction).toHaveBeenCalledWith("om_1", "re_3");
  });

  it("clear：无 reactionId → 不调 removeReaction", async () => {
    const d = deps();
    const r = createReactionManager(d);
    await r.react("om_2", "OK"); // 无 reaction_id
    await r.clear("om_2");
    expect(d.removeReaction).not.toHaveBeenCalled();
  });

  it("clear：removeReaction 抛错 → 忽略且清缓存", async () => {
    const d = deps({
      addReaction: vi.fn().mockResolvedValue({ reaction_id: "re_4" }),
      removeReaction: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const r = createReactionManager(d);
    await r.react("om_3", "OK");
    await r.clear("om_3"); // 不崩
  });

  it("clear：未 react 过 → 直接清空不报错", async () => {
    const d = deps();
    const r = createReactionManager(d);
    await r.clear("om_none");
    expect(d.removeReaction).not.toHaveBeenCalled();
  });
});
