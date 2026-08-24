/**
 * 入站消息解析（M1 只处理 text）
 *
 * 参考成熟桥接实现。
 * 输出归一化对象：{chatId, userId, text, messageId, chatType, mentions}。
 * 自动剥离消息首尾的 @bot 提及。
 */

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  userId: string;
  /** 剥离 @bot 后的纯净文本 */
  text: string;
  /** 原始文本（未剥离） */
  rawText: string;
  mentions: string[];
  timestamp: number;
}

function pickText(contentRaw: string): string {
  if (!contentRaw) return "";
  try {
    const parsed = JSON.parse(contentRaw) as { text?: string; content?: string };
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
    return contentRaw;
  } catch {
    return contentRaw;
  }
}

/** 剥离 @bot 提及（开头连续提及 + 尾部多余空格） */
export function stripMentions(text: string, mentions: string[], botOpenId?: string): string {
  let cur = text.trim();
  const mentionTargets = new Set<string>();
  for (const m of mentions) mentionTargets.add(m);
  if (botOpenId) mentionTargets.add(botOpenId);
  let changed = true;
  while (changed) {
    changed = false;
    // 开头：<at id=xxx></at> 或 @名字
    const next = cur.replace(/^(?:<at[^>]*>.*?<\/at>|@\S+)\s*/i, "").trim();
    if (next !== cur) {
      cur = next;
      changed = true;
    }
  }
  return cur;
}

/** 解析飞书消息事件 → ParsedMessage；非 text 或缺关键字段返回 undefined */
export function parseInboundMessage(raw: any, botOpenId?: string): ParsedMessage | undefined {
  const msg = raw.message ?? raw;
  const messageId: string | undefined = msg.message_id ?? raw.message_id;
  const chatId: string | undefined = msg.chat_id ?? raw.chat_id;
  if (!messageId || !chatId) return undefined;

  const chatType: "p2p" | "group" = (msg.chat_type ?? raw.chat_type ?? "p2p") === "group" ? "group" : "p2p";
  const senderOpenId: string = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";
  const msgType: string | undefined = msg.message_type ?? raw.message_type;

  // M1 只处理 text；其他类型跳过（M2 全类型）
  if (msgType && msgType !== "text") return undefined;

  const content: string = msg.content ?? raw.content ?? "";
  const rawText = pickText(content);
  if (!rawText.trim()) return undefined;

  const mentions: string[] = (msg.mentions ?? []).map((m: any) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "").filter(Boolean);

  return {
    messageId,
    chatId,
    chatType,
    userId: senderOpenId,
    text: stripMentions(rawText, mentions, botOpenId),
    rawText,
    mentions,
    timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now()),
  };
}
