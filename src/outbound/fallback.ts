/**
 * 发送降级（M2）
 *
 * - post/卡片被飞书拒绝（权限/格式）→ 降级纯文本
 * - reply 失败（230011/231003）→ 降级 create 新消息
 */

/** 飞书错误码判断 */
export function isReplyFailure(code: string | number | undefined): boolean {
  return code === 230011 || code === 231003;
}

/** 判断是否"可降级"的错误（权限/格式类） */
export function isDegradableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string | number })?.code;
  return (
    isReplyFailure(code) ||
    /230011|231003|permission|denied|not allowed|invalid.*content|no permission/i.test(msg)
  );
}

/** 剥掉 markdown 符号 → 纯文本（降级用） */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim())
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\|/g, "")
    .trim();
}
