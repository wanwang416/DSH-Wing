import { describe, expect, it } from "vitest";
import { parseWecomInbound, isWecomChatId, extractWecomMentions, consumeWecomGroupDiag } from "../../src/inbound/wecom-parser.js";

describe("parseWecomInbound：单聊（主场景）", () => {
  it("text 单聊 → chatId=from.userid / p2p / platform=wecom / 文本直通", () => {
    const msg = parseWecomInbound({
      msgid: "m1",
      aibotid: "bot1",
      chattype: "single",
      from: { userid: "alan001" },
      create_time: 1700000000,
      msgtype: "text",
      text: { content: " 你好 " },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        messageId: "m1",
        chatId: "alan001",
        chatType: "p2p",
        userId: "alan001",
        text: "你好",
        rawText: "你好",
        platform: "wecom",
      }),
    );
    expect(msg!.mentions).toEqual([]);
  });

  it("无 msgid → undefined", () => {
    expect(
      parseWecomInbound({ chattype: "single", from: { userid: "u1" }, text: { content: "hi" } }),
    ).toBeUndefined();
  });

  it("无 sender userid → undefined", () => {
    expect(parseWecomInbound({ msgid: "m1", chattype: "single", text: { content: "hi" } })).toBeUndefined();
  });

  it("无任何可解析文本且非已知非文本类型 → undefined", () => {
    expect(parseWecomInbound({ msgid: "m1", chattype: "single", from: { userid: "u1" } })).toBeUndefined();
  });
});

describe("parseWecomInbound：群聊", () => {
  it("group + @ 提及 → chatId=chatid / group / mentions 提取", () => {
    const msg = parseWecomInbound({
      msgid: "m2",
      chattype: "group",
      chatid: "grp_1",
      from: { userid: "u2" },
      msgtype: "text",
      text: { content: "@DSH机器人 帮我查天气" },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        chatId: "grp_1",
        chatType: "group",
        userId: "u2",
        text: "@DSH机器人 帮我查天气",
        platform: "wecom",
      }),
    );
    expect(msg!.mentions).toContain("@DSH机器人");
  });

  it("群聊无 chatid → undefined", () => {
    expect(
      parseWecomInbound({ msgid: "m3", chattype: "group", from: { userid: "u1" }, text: { content: "hi" } }),
    ).toBeUndefined();
  });
});

describe("parseWecomInbound：语音/混合/引用/非文本", () => {
  it("voice 已转文本 → 走文本路径", () => {
    const msg = parseWecomInbound({
      msgid: "m4",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "voice",
      voice: { content: "语音转写内容" },
    });
    expect(msg!.text).toBe("语音转写内容");
  });

  it("mixed → 取文本项", () => {
    const msg = parseWecomInbound({
      msgid: "m5",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "image", image: {} },
          { msgtype: "text", text: { content: "混合消息文本" } },
        ],
      },
    });
    expect(msg!.text).toBe("混合消息文本");
  });

  it("quote → 引用文本并入正文作上下文", () => {
    const msg = parseWecomInbound({
      msgid: "m6",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "text",
      text: { content: "接着说" },
      quote: { msgtype: "text", text: { content: "上一句" } },
    });
    expect(msg!.text).toContain("上一句");
    expect(msg!.text).toContain("接着说");
  });

  it("image → 摘要占位", () => {
    const msg = parseWecomInbound({
      msgid: "m7",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "image",
      image: { url: "https://x/img.png" },
    });
    expect(msg!.text).toBe("[用户发送了图片]");
  });

  it("file → 摘要占位", () => {
    const msg = parseWecomInbound({
      msgid: "m8",
      chattype: "single",
      from: { userid: "u1" },
      msgtype: "file",
      file: { url: "https://x/f.pdf" },
    });
    expect(msg!.text).toBe("[用户发送了文件]");
  });
});

describe("extractWecomMentions", () => {
  it("提取 @提及（@后非空白串）", () => {
    expect(extractWecomMentions("@DSH机器人 帮我 @小王 看看")).toEqual(["@DSH机器人", "@小王"]);
  });
  it("无 @ → 空数组", () => {
    expect(extractWecomMentions("普通消息")).toEqual([]);
  });
});

describe("isWecomChatId", () => {
  it("飞书前缀 → false", () => {
    expect(isWecomChatId("oc_abc")).toBe(false);
    expect(isWecomChatId("ou_abc")).toBe(false);
    expect(isWecomChatId("oi_abc")).toBe(false);
    expect(isWecomChatId("cli_abc")).toBe(false);
  });
  it("企微 userid / 群 chatid（无前缀）→ true", () => {
    expect(isWecomChatId("alan001")).toBe(true);
    expect(isWecomChatId("grp_1")).toBe(true);
    expect(isWecomChatId("wb_abc123")).toBe(true);
  });
});

describe("extractWecomMentions：D2/A botName 精确匹配", () => {
  it("botName 有值 → 仅精确命中 @机器人名，@同事不产生提及", () => {
    expect(extractWecomMentions("@DSH机器人 帮我 @小王 看看", "DSH机器人")).toEqual(["@DSH机器人"]);
  });
  it("全角 ＠ 命中", () => {
    expect(extractWecomMentions("＠DSH机器人 在吗", "DSH机器人")).toEqual(["@DSH机器人"]);
  });
  it("大小写不敏感 + 去空白（显示名含空格）", () => {
    expect(extractWecomMentions("@dsh 助手 在吗", "DSH助手")).toEqual(["@dsh 助手"]);
  });
  it("未配置 botName → 宽松提取全部 @（S5 提示补配）", () => {
    expect(extractWecomMentions("@小王 帮我", undefined)).toEqual(["@小王"]);
  });
});

describe("consumeWecomGroupDiag（S5）", () => {
  it("进程内首次 true，之后恒 false（诊断仅一次）", () => {
    expect(consumeWecomGroupDiag()).toBe(true);
    expect(consumeWecomGroupDiag()).toBe(false);
    expect(consumeWecomGroupDiag()).toBe(false);
  });
});

describe("parseWecomInbound：群聊 botName 精确（D2）", () => {
  it("群聊 @机器人名 + opts.botName → mentions 仅机器人", () => {
    const msg = parseWecomInbound(
      {
        msgid: "m9",
        chattype: "group",
        chatid: "grp_2",
        from: { userid: "u3" },
        msgtype: "text",
        text: { content: "@DSH机器人 天气" },
      },
      { botName: "DSH机器人" },
    );
    expect(msg!.mentions).toEqual(["@DSH机器人"]);
  });
  it("群聊 @同事（未 @机器人）→ mentions 为空", () => {
    const msg = parseWecomInbound(
      {
        msgid: "m10",
        chattype: "group",
        chatid: "grp_2",
        from: { userid: "u3" },
        msgtype: "text",
        text: { content: "@小王 中午吃啥" },
      },
      { botName: "DSH机器人" },
    );
    expect(msg!.mentions).toEqual([]);
  });
});

