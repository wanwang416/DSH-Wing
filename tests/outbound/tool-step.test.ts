import { describe, expect, it } from "vitest";
import {
  truncateText,
  toolArgsSummary,
  humanizeToolName,
  contextStep,
  thinkingStep,
  toolCallStep,
  stepRowContent,
  compactSteps,
  stepsFallbackMarkdown,
} from "../../src/outbound/tool-step.js";

describe("ToolStep 构建（对齐基底 core/streaming.go + Web UI trajectory）", () => {
  it("上下文注入 → 📥 上下文注入", () => {
    const step = contextStep("用户补充了要求");
    expect(step.kind).toBe("context");
    expect(step.name).toBe("上下文注入");
    expect(step.done).toBe(true);
    expect(stepRowContent(step)).toContain("📥");
    expect(stepRowContent(step)).toContain("上下文注入");
  });

  it("thinking → 💭 Thinking", () => {
    const step = thinkingStep("让我想想...");
    expect(step.kind).toBe("thinking");
    expect(stepRowContent(step)).toContain("💭");
    expect(stepRowContent(step)).toContain("Thinking");
  });

  it("tool call → 🔧 工具名 + 参数摘要（JSON 解析）", () => {
    const step = toolCallStep("Bash", '{"command":"npm test","cwd":"/d/ACC"}');
    expect(step.kind).toBe("tool");
    expect(step.done).toBe(false);
    expect(step.name).toBe("Bash");
    expect(step.summary).toBe("npm test"); // 取第一个字符串参数
    const row = stepRowContent(step);
    expect(row).toContain("🔧");
    expect(row).toContain("Bash");
    expect(row).toContain("npm test");
  });

  it("toolArgsSummary：非法 JSON 原样截断；空参数返回空", () => {
    expect(toolArgsSummary(undefined)).toBe("");
    expect(toolArgsSummary("{}")).toBe("");
    expect(toolArgsSummary("not-json-{{{")).toBe("not-json-{{{");
    expect(toolArgsSummary('{"path":"a".repeat(300)}')?.length).toBeLessThanOrEqual(123); // 截断
  });

  it("truncateText 超长加 ...", () => {
    expect(truncateText("abcde", 3)).toBe("abc...");
    expect(truncateText("abcde", 10)).toBe("abcde");
  });

  it("humanizeToolName 保留原名 / 空兜底", () => {
    expect(humanizeToolName("Read")).toBe("Read");
    expect(humanizeToolName("")).toBe("Tool");
  });
});

describe("富卡片降级辅助（C2）", () => {
  it("compactSteps 超 10 步 → 隐藏提示 + 保留最近 10", () => {
    const steps = Array.from({ length: 15 }, (_, i) => toolCallStep(`Tool${i}`, `args${i}`));
    const { visible, hidden } = compactSteps(steps, 10);
    expect(hidden).toBe(5);
    expect(visible).toHaveLength(10);
    expect(visible[0].name).toBe("Tool5");
  });

  it("stepsFallbackMarkdown：隐藏提示 + 步骤列表", () => {
    const steps = [contextStep("注入"), toolCallStep("Read", "/a/b.md"), toolCallStep("Bash", "npm build")];
    const md = stepsFallbackMarkdown(steps);
    expect(md).toContain("- 📥 上下文注入");
    expect(md).toContain("- 🔧 Read");
  });
});
