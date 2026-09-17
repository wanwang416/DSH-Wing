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
  /** 来源平台（默认飞书；企微线路由 wecom-parser 标记，用于 session/outbox 双路由隔离） */
  platform?: "feishu" | "wecom";
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
  let changed = true;
  while (changed) {
    changed = false;
    // 1) <at> 标签（飞书）
    const nextTag = cur.replace(/^(?:<at[^>]*>.*?<\/at>)\s*/i, "").trim();
    if (nextTag !== cur) {
      cur = nextTag;
      changed = true;
      continue;
    }
    // 2) 显式 mentions 前缀（S2：按 mentions 项精确长度剥离，兼容含空格 botName 如「DSH 助手」）
    for (const m of mentions) {
      if (m && cur.startsWith(m)) {
        cur = cur.slice(m.length).trim();
        changed = true;
        break;
      }
    }
    // 3) 兜底：任意 @ 前缀（兼容未登记提及；半角 @ 与全角 ＠）
    if (!changed) {
      const nextAt = cur.replace(/^(?:[@＠]\S+)\s*/i, "").trim();
      if (nextAt !== cur) {
        cur = nextAt;
        changed = true;
      }
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
