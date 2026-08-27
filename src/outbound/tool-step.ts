/**
 * ToolStep — 工具步骤数据结构 + 行构建（★M3 任务 3：ToolStep 富卡片分行展示）
 *
 * 对齐成熟桥接 `core/streaming.go` 的 ToolStep：
 * - Kind: thinking | tool（+ 本项目扩展 context=上下文注入，对齐 Web UI trajectory 的 context 记录）
 * - Name / Summary / Result / Done
 *
 * 显示对齐 Web UI：
 * - 上下文注入 → 📥 上下文注入
 * - thinking → 💭 思考中...
 * - tool call → 🔧 <工具名>（带参数摘要）
 * - tool result → ✅/❌ <工具名>（带结果摘要，超长截断）
 */

/** 步骤种类：thinking=思考 / tool=工具调用 / context=上下文注入 */
export type ToolStepKind = "thinking" | "tool" | "context";

export interface ToolStep {
  kind: ToolStepKind;
  /** 工具名（如 "Bash" / "Read" / "Code"） */
  name: string;
  /** 展示文本（参数摘要 / 思考片段 / 注入摘要） */
  summary: string;
  /** 可选结果摘要 */
  result?: string;
  /** 是否已有 result（工具调用结束） */
  done: boolean;
  /** 是否失败 */
  error?: boolean;
}

/** 截断长文本（对齐基底 compactRichText：按字符，超长加 "..."） */
export function truncateText(s: string, maxRunes = 200): string {
  const t = (s ?? "").trim();
  if (t.length <= maxRunes) return t;
  return t.slice(0, maxRunes) + "...";
}

/** 从工具参数 JSON（字符串）提取摘要：解析失败则原样截断 */
export function toolArgsSummary(rawArgs: string | undefined): string {
  if (!rawArgs) return "";
  const t = rawArgs.trim();
  if (t === "" || t === "{}") return "";
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return "";
    // 取第一个有意义的参数值作为摘要（命令/路径/查询等），超长截断
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim() !== "") return truncateText(v, 120);
    }
    return truncateText(t, 120);
  } catch {
    return truncateText(t, 120);
  }
}

/** 工具显示名（简化 humanizeToolName；保留 Code/Read/Glob 等英文原名） */
export function humanizeToolName(name: string): string {
  const n = (name ?? "").trim();
  if (!n) return "Tool";
  return n;
}

/** 上下文注入步骤（Web UI context 记录 → 📥） */
export function contextStep(summary?: string): ToolStep {
  return {
    kind: "context",
    name: "上下文注入",
    summary: summary ?? "",
    done: true,
  };
}

/** 思考步骤（reasoning-delta 累积 → 💭） */
export function thinkingStep(text: string): ToolStep {
  return {
    kind: "thinking",
    name: "Thinking",
    summary: text,
    done: true,
  };
}

/** 工具调用步骤（tool/call → 🔧 <工具名>） */
export function toolCallStep(name: string, input?: string): ToolStep {
  return {
    kind: "tool",
    name: humanizeToolName(name),
    summary: toolArgsSummary(input),
    done: false,
  };
}

/** 步骤行展示（对齐基底 richStepRowContent：名称 + 摘要，多行压成一行） */
export function stepRowContent(step: ToolStep): string {
  const icon = step.kind === "context" ? "📥" : step.kind === "thinking" ? "💭" : step.error ? "❌" : step.done ? "✅" : "🔧";
  const name = step.kind === "thinking" ? "Thinking" : step.kind === "context" ? "上下文注入" : step.name;
  let text = `${icon} ${name}`;
  if (step.summary) {
    const summaryLine = step.summary.includes("\n") ? step.summary.split("\n")[0] : step.summary;
    if (summaryLine !== name) text += ` — ${summaryLine}`;
  }
  if (step.result && step.result !== step.summary) {
    const resultLine = step.result.includes("\n") ? step.result.split("\n")[0] : step.result;
    text += ` · ${resultLine}`;
  }
  return text;
}

/** 富卡片压缩：保留最近 N 条步骤（对齐基底 richPanelElements maxPanelSteps=10 + compactRichStepsForCardSize） */
export function compactSteps(steps: ToolStep[], perLane = 10): { visible: ToolStep[]; hidden: number } {
  const visible = steps.length > perLane ? steps.slice(steps.length - perLane) : steps;
  return { visible, hidden: Math.max(0, steps.length - perLane) };
}

/** 富卡片超限降级：把最近步骤压缩为单行 markdown 列表（对齐基底 compactRichFallbackMarkdown） */
export function stepsFallbackMarkdown(steps: ToolStep[]): string {
  const { visible, hidden } = compactSteps(steps, 3);
  const lines: string[] = [];
  if (hidden > 0) lines.push(`*... ${hidden} 个更早步骤已隐藏*`);
  for (const step of visible) {
    const line = stepRowContent(step).replace(/\n/g, " · ");
    if (line.trim()) lines.push(`- ${line}`);
  }
  return lines.join("\n");
}
