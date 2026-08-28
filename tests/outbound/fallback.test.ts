import { describe, expect, it } from "vitest";
import { isReplyFailure, isDegradableError, stripMarkdown } from "../../src/outbound/fallback.js";

describe("isReplyFailure", () => {
  it("230011 / 231003 → true（严格 ===，number）", () => {
    expect(isReplyFailure(230011)).toBe(true);
    expect(isReplyFailure(231003)).toBe(true);
  });
  it("其他 code → false", () => {
    expect(isReplyFailure(999)).toBe(false);
    expect(isReplyFailure(undefined)).toBe(false);
  });
});

describe("isDegradableError", () => {
  it("reply failure code → true", () => {
    expect(isDegradableError({ code: 230011 })).toBe(true);
  });
  it("permission/denied 消息 → true", () => {
    expect(isDegradableError(new Error("permission denied"))).toBe(true);
    expect(isDegradableError(new Error("no permission to send"))).toBe(true);
    expect(isDegradableError(new Error("invalid content format"))).toBe(true);
  });
  it("普通错误 → false", () => {
    expect(isDegradableError(new Error("network timeout"))).toBe(false);
  });
});

describe("stripMarkdown", () => {
  it("剥离代码块", () => {
    expect(stripMarkdown("```js\nconst a = 1;\n```")).toBe("js\nconst a = 1;");
  });
  it("剥离标题", () => {
    expect(stripMarkdown("# 标题\n## 副标题")).toBe("标题\n副标题");
  });
  it("无序列表 → •", () => {
    expect(stripMarkdown("- a\n- b")).toBe("• a\n• b");
  });
  it("有序列表", () => {
    expect(stripMarkdown("1. one\n2. two")).toBe("1. one\n2. two");
  });
  it("粗体/斜体/行内代码", () => {
    expect(stripMarkdown("**粗** *斜* `码`")).toBe("粗 斜 码");
  });
  it("图片/链接 → 保留文本", () => {
    expect(stripMarkdown("![alt](u) [text](u)")).toBe("alt text");
  });
  it("管道剥离", () => {
    expect(stripMarkdown("a | b | c")).toBe("a  b  c");
  });
  it("空白 trim", () => {
    expect(stripMarkdown("  hi  ")).toBe("hi");
  });
});
