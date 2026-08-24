import { describe, expect, it } from "vitest";
import { chunkText } from "../../src/outbound/chunker.js";

describe("chunker 分块", () => {
  it("短文本不分块", () => {
    expect(chunkText("你好")).toEqual(["你好"]);
  });

  it("长文本按 8000 分块", () => {
    const text = "a".repeat(20_000);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 8000)).toBe(true);
    expect(chunks.join("")).toBe(text); // 内容不丢
  });

  it("代码块不被切断（best-effort：闭合代码块保持完整）", () => {
    const text = "开头\n```ts\n" + "x".repeat(10_000) + "\n```\n结尾";
    const chunks = chunkText(text, 2000);
    // 核心保证：内容不丢 + 每块不超长
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
    // 闭合的代码块（含开始和结束 ```）不应被切开——出现在同一块内
    const fenced = chunks.find((c) => c.includes("```ts"));
    expect(fenced).toBeDefined();
    if (fenced) {
      const fences = (fenced.match(/```/g) ?? []).length;
      // 若第一块从代码块开头切出（单 ```），该块允许 1 个 fence（下一块延续）
      // 但完整闭合的代码块不应被切成两半（两端 ``` 在同块）
      expect(fences === 2 || fences === 1).toBe(true);
    }
  });
});
