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
  /** 回复消息的父消息 id（reply 群策略用） */
  parentId?: string;
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

/** 非 text 消息 → 给 agent 的摘要文本（M2 全类型） */
function summarizeNonText(msgType: string, contentRaw: string): string | undefined {
  switch (msgType) {
    case "image":
      return "[用户发送了图片]";
    case "file":
      return "[用户发送了文件]";
    case "audio":
      return "[用户发送了语音]";
    case "video":
      return "[用户发送了视频]";
    case "merge_forward":
      return "[用户转发了多条消息]";
    case "share_chat":
      return "[用户分享了群聊]";
    case "sticker":
      return "[用户发送了表情包]";
    case "post": {
      const parsed = pickText(contentRaw);
      return parsed && parsed.trim() ? parsed : "[用户发送了富文本消息]";
    }
    default:
      return undefined; // 未知类型跳过
  }
}

/** 解析飞书消息事件 → ParsedMessage；无法解析返回 undefined（M2 全类型） */
export function parseInboundMessage(raw: any, botOpenId?: string): ParsedMessage | undefined {
  const msg = raw.message ?? raw;
  const messageId: string | undefined = msg.message_id ?? raw.message_id;
  const chatId: string | undefined = msg.chat_id ?? raw.chat_id;
  if (!messageId || !chatId) return undefined;

  const chatType: "p2p" | "group" = (msg.chat_type ?? raw.chat_type ?? "p2p") === "group" ? "group" : "p2p";
  const senderOpenId: string = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";
  const msgType: string | undefined = msg.message_type ?? raw.message_type;

  const content: string = msg.content ?? raw.content ?? "";
  const rawText = msgType && msgType !== "text" ? summarizeNonText(msgType, content) : pickText(content);
  if (!rawText || !rawText.trim()) return undefined;

  const mentions: string[] = (msg.mentions ?? []).map((m: any) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "").filter(Boolean);

  return {
    messageId,
    chatId,
    chatType,
    userId: senderOpenId,
    text: stripMentions(rawText, mentions, botOpenId),
    rawText,
    mentions,
    ...(msg.parent_id ?? raw.parent_id ? { parentId: msg.parent_id ?? raw.parent_id } : {}),
    timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now()),
  };
}
