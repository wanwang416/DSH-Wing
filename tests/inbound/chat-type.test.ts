import { describe, expect, it } from "vitest";
import { chatTypeOf } from "../../src/inbound/chat-type.js";

describe("chatTypeOf（M4-R3 任务 4：仅兜底，oc_ 前缀不可靠）", () => {
  it("oc_ 前缀 → 兜底猜测 group（⚠️ 仅无真值时用：P2P 会话 chat_id 也是 oc_ 前缀）", () => {
    expect(chatTypeOf("oc_abc123")).toBe("group");
  });

  it("ou_ 前缀 → p2p（单聊 open_id）", () => {
    expect(chatTypeOf("ou_user_1")).toBe("p2p");
  });

  it("非 oc_ 前缀（空串/无前缀）→ p2p", () => {
    expect(chatTypeOf("")).toBe("p2p");
    expect(chatTypeOf("plain-id")).toBe("p2p");
  });

  it("oc_ 仅前缀边界 → group（兜底）", () => {
    expect(chatTypeOf("oc_")).toBe("group");
  });
});
