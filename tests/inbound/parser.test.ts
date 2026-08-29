import { describe, expect, it } from "vitest";
import { parseInboundMessage, stripMentions } from "../../src/inbound/parser.js";

function textMsg(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: "om_1",
      chat_id: "oc_g1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
      ...(overrides.message ?? {}),
    },
    sender: { sender_id: { open_id: "ou_sender" } },
    ...(overrides.raw ?? {}),
  };
}

describe("parseInboundMessage 基础解析", () => {
  it("群聊 text → chatId/chatType/userId/text 归一化", () => {
    const p = parseInboundMessage(textMsg());
    expect(p).toMatchObject({
      messageId: "om_1",
      chatId: "oc_g1",
      chatType: "group",
      userId: "ou_sender",
      text: "你好",
      rawText: "你好",
      mentions: [],
    });
    expect(p!.timestamp).toBeGreaterThan(0);
  });

  it("p2p + 缺省 chat_type → p2p", () => {
    const p = parseInboundMessage(textMsg({ message: { chat_type: "p2p", chat_id: "ou_u1" } }));
    expect(p!.chatType).toBe("p2p");
  });

  it("content 为 content 字段（富文本结构）", () => {
    const p = parseInboundMessage(
      textMsg({ message: { content: JSON.stringify({ content: "内文" }) } }),
    );
    expect(p!.text).toBe("内文");
  });

  it("content 非 JSON → 原样返回", () => {
    const p = parseInboundMessage(textMsg({ message: { content: "纯文本" } }));
    expect(p!.text).toBe("纯文本");
  });

  it("缺 message_id 或 chat_id → undefined", () => {
    expect(parseInboundMessage(textMsg({ message: { message_id: undefined } }))).toBeUndefined();
    expect(parseInboundMessage(textMsg({ message: { chat_id: undefined } }))).toBeUndefined();
  });

  it("空文本 → undefined", () => {
    const p = parseInboundMessage(textMsg({ message: { content: JSON.stringify({ text: "  " }) } }));
    expect(p).toBeUndefined();
  });

  it("parent_id + create_time → parentId/timestamp", () => {
    const p = parseInboundMessage(
      textMsg({ message: { parent_id: "om_parent", create_time: "1700000000000" } }),
    );
    expect(p!.parentId).toBe("om_parent");
    expect(p!.timestamp).toBe(1700000000000);
  });

  it("sender 缺省 → userId=unknown；operator 兜底", () => {
    const p = parseInboundMessage(textMsg({ raw: { sender: undefined, operator: { operator_id: { open_id: "ou_op" } } } }));
    expect(p!.userId).toBe("ou_op");
    const p2 = parseInboundMessage(textMsg({ raw: { sender: undefined } }));
    expect(p2!.userId).toBe("unknown");
  });

  it("raw 直接是消息结构（无 message 包裹）", () => {
    const p = parseInboundMessage({ message_id: "om_2", chat_id: "ou_u1", message_type: "text", content: JSON.stringify({ text: "x" }) });
    expect(p!.messageId).toBe("om_2");
  });
});

describe("非 text 消息 → 摘要（M2 全类型）", () => {
  const cases: Array<[string, string]> = [
    ["image", "[用户发送了图片]"],
    ["file", "[用户发送了文件]"],
    ["audio", "[用户发送了语音]"],
    ["video", "[用户发送了视频]"],
    ["merge_forward", "[用户转发了多条消息]"],
    ["share_chat", "[用户分享了群聊]"],
    ["sticker", "[用户发送了表情包]"],
  ];
  for (const [msgType, expected] of cases) {
    it(`${msgType} → ${expected}`, () => {
      const p = parseInboundMessage(textMsg({ message: { message_type: msgType, content: "{}" } }));
      expect(p!.text).toBe(expected);
    });
  }

  it("post 含文本 → 提取文本", () => {
    const p = parseInboundMessage(textMsg({ message: { message_type: "post", content: JSON.stringify({ content: "富文本正文" }) } }));
    expect(p!.text).toBe("富文本正文");
  });

  it("post 无文本 → 占位摘要", () => {
    const p = parseInboundMessage(textMsg({ message: { message_type: "post", content: "" } }));
    expect(p!.text).toBe("[用户发送了富文本消息]");
  });

  it("未知类型 → undefined（跳过）", () => {
    expect(parseInboundMessage(textMsg({ message: { message_type: "unknown_xxx" } }))).toBeUndefined();
  });
});

describe("stripMentions 剥离 @bot", () => {
  it("开头 <at> 提及 + 尾部空格剥离", () => {
    expect(stripMentions('<at id=ou_bot></at>  hello  ', ["ou_bot"], "ou_bot")).toBe("hello");
  });

  it("@名字 剥离", () => {
    expect(stripMentions("@wing 早上好", [], "ou_bot")).toBe("早上好");
  });

  it("连续多个 <at> 全部剥离", () => {
    expect(stripMentions('<at id=ou_bot></at><at id=ou_2></at>ok', ["ou_bot", "ou_2"], "ou_bot")).toBe("ok");
  });

  it("mentions 用 id/name 兜底", () => {
    const p = parseInboundMessage(textMsg({ message: { mentions: [{ id: { open_id: "ou_bot" } }, { name: "wing" }] } }));
    expect(p!.mentions).toEqual(["ou_bot", "wing"]);
  });

  it("botOpenId 追加进提及目标", () => {
    // 提及列表不含 botOpenId，但 @名字匹配 open_id
    expect(stripMentions("@wing hi", [], "ou_bot")).toBe("hi");
  });
});
