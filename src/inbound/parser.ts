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

  const chatTypeRaw = msg.chat_type ?? raw.chat_type;
  // ★ M22-③（2026-10-02 阶段4）：chat_type 缺失不再默认 "p2p"——缺 chat_type 的群消息会被
  //   当成私聊从而**绕过群策略**。改为：缺失 → warn 并按 "group" 宽松分支处理（群策略的
  //   未命中规则决定后续；代价可控，漏处理优于越权处理），并在 ParsedMessage 上如实标记 "unknown"。
  let chatType: "p2p" | "group";
  let chatTypeKnown = true;
  if (chatTypeRaw === "group") chatType = "group";
  else if (chatTypeRaw === "p2p") chatType = "p2p";
  else {
    chatType = "group"; // 未知 → 宽松分支
    chatTypeKnown = false;
  }
  const senderOpenId: string = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";

  const content: string = msg.content ?? raw.content ?? "";
  const msgType: string | undefined = msg.message_type ?? raw.message_type;
  const rawText = msgType && msgType !== "text" ? summarizeNonText(msgType, content) : pickText(content);
  if (!rawText || !rawText.trim()) return undefined;
  if (!chatTypeKnown) {
    // warn 输出经 dispatcher 的 logger 透出没有 parser 级 logger——在此用返回字段标记，
    // dispatcher 侧统一打 warn（避免 parser 引入 logger 依赖）。
    (raw as any).__chatTypeUnknown = true;
  }

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
