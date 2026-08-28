import { describe, expect, it } from "vitest";
import { chatTypeOf } from "../../src/inbound/chat-type.js";

describe("chatTypeOf（M4 任务 4a：合批 flush chat_type 动态判断）", () => {
  it("oc_ 前缀 → group（群聊）", () => {
    expect(chatTypeOf("oc_abc123")).toBe("group");
  });

  it("ou_ 前缀 → p2p（单聊 open_id）", () => {
    expect(chatTypeOf("ou_user_1")).toBe("p2p");
  });

  it("非 oc_ 前缀（如空串/无前缀）→ p2p", () => {
    expect(chatTypeOf("")).toBe("p2p");
    expect(chatTypeOf("plain-id")).toBe("p2p");
  });

  it("oc_ 仅前缀边界 → group", () => {
    expect(chatTypeOf("oc_")).toBe("group");
  });
});
