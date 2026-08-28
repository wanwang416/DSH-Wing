import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, buildMarkdownCard } from "../../src/outbound/cardkit.js";

describe("looksLikeMarkdown", () => {
  it("标题 → true", () => {
    expect(looksLikeMarkdown("# 标题\n正文")).toBe(true);
    expect(looksLikeMarkdown("## 二级")).toBe(true);
  });

  it("无序列表 → true", () => {
    expect(looksLikeMarkdown("- 项1\n- 项2")).toBe(true);
    expect(looksLikeMarkdown("* 星号项")).toBe(true);
    expect(looksLikeMarkdown("+ 加号项")).toBe(true);
  });

  it("有序列表 → true", () => {
    expect(looksLikeMarkdown("1. 第一\n2. 第二")).toBe(true);
  });

  it("代码块 → true", () => {
    expect(looksLikeMarkdown("```js\nconst a = 1;\n```")).toBe(true);
  });

  it("表格 → true", () => {
    expect(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });

  it("图片 → true", () => {
    expect(looksLikeMarkdown("![图](https://x/y.png)")).toBe(true);
  });

  it("纯文本 → false", () => {
    expect(looksLikeMarkdown("这是一段普通文本")).toBe(false);
  });

  it("超长（>28000）→ false", () => {
    expect(looksLikeMarkdown("# x\n" + "a".repeat(28_000))).toBe(false);
  });
});

describe("buildMarkdownCard", () => {
  it("schema 2.0 + markdown 元素", () => {
    const card = buildMarkdownCard("**加粗**内容");
    expect(card.schema).toBe("2.0");
    expect(card.config).toEqual({ update_multi: true });
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "**加粗**内容" }]);
  });
});
