/**
 * markdown → CardKit 卡片渲染（M2）
 *
 * 检测 markdown 特征（标题/列表/代码块/表格）→ 构建 interactive 卡片；
 * 纯文本走 text 消息（sender 已有逻辑）。
 * ★ StreamingCard 已覆盖单卡流式；本模块用于最终回复的富文本卡片化。
 */

/** 检测文本是否含 markdown 特征 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > 28_000) return false;
  return (
    /^#{1,6}\s/m.test(text) || // 标题
    /^\s*[-*+]\s/m.test(text) || // 无序列表
    /^\s*\d+\.\s/m.test(text) || // 有序列表
    /```/.test(text) || // 代码块
    /\|.*\|.*\n\|[-:|\s]+\|/.test(text) || // 表格
    /!\[.*\]\(.*\)/.test(text) // 图片
  );
}

/** 构建 markdown 卡片 JSON（schema 2.0，markdown 单元素） */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  };
}
