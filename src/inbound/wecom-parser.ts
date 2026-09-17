/**
 * 企业微信入站消息解析：aibot_msg_callback → DSH-Wing 统一 ParsedMessage。
 *
 * 关键设计（与飞书 parser 对齐，输出同构对象，直接进 handleInbound）：
 *   - 单聊（chattype=single）：chatId = from.userid → 直通 handleInbound（p2p 永不过滤）
 *   - 群聊（chattype=group）：chatId = chatid → 走现有 groupPolicy（mention 策略）
 *   - 企微无结构化 mentions 字段：群聊 @ 机器人表现为文本 "@机器人名 xxx"，提取为 mentions
 *     供 stripMentions 剥除前缀；文本中间 @ 保留原样
 *   - voice 已由企微服务端转文本（voice.content），走文本路径
 *   - quote（引用回复）：企微长连接暂无原消息 msgid 字段，parentId 不设；
 *     引用文本并入 text 作为上下文（对齐哈马 extractWecomQuoteText 的意图）
 *   - image/file/video → 摘要占位（与飞书 summarizeNonText 同策略）
 */

import type { ParsedMessage } from "./parser.js";

export interface WecomInboundBody {
  msgid?: string;
  aibotid?: string;
  chatid?: string;
  chattype?: "single" | "group" | string;
  msgtype?: string;
  from?: { userid?: string };
  create_time?: number;
  text?: { content?: string };
  voice?: { content?: string };
  mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> };
  image?: { url?: string; aeskey?: string };
  file?: { url?: string; aeskey?: string };
  video?: { url?: string; aeskey?: string };
  quote?: {
    msgtype?: string;
    text?: { content?: string };
    voice?: { content?: string };
    mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> };
  };
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mixedText(mixed: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> } | undefined): string {
  return (mixed?.msg_item ?? [])
    .filter((item) => item.msgtype === "text")
    .map((item) => cleanText(item.text?.content))
    .filter(Boolean)
    .join("\n");
}

/** 提取一条企微消息的用户可见文本（text / voice 转写 / mixed 文本项） */
export function extractWecomText(body: WecomInboundBody | undefined): string {
  if (!body) return "";
  return [cleanText(body.text?.content), cleanText(body.voice?.content), mixedText(body.mixed)].filter(Boolean).join("\n").trim();
}

/** 引用消息文本：企微无原 msgid，仅并入正文作上下文 */
export function extractWecomQuoteText(body: WecomInboundBody | undefined): string {
  const quote = body?.quote;
  if (!quote) return "";
  return [cleanText(quote.text?.content), cleanText(quote.voice?.content), mixedText(quote.mixed)].filter(Boolean).join("\n").trim();
}

/** 非文本消息 → 给 agent 的摘要占位（对齐飞书 summarizeNonText 策略） */
function summarizeNonText(msgType: string | undefined): string | undefined {
  switch (msgType) {
    case "image":
      return "[用户发送了图片]";
    case "file":
      return "[用户发送了文件]";
    case "video":
      return "[用户发送了视频]";
    case "mixed":
      return undefined; // mixed 的文本项已在 extractWecomText 提取
    default:
      return undefined;
  }
}

/** 提取企微群聊文本中的 @提及（半角 @ / 全角 ＠；D2/A：botName 有值时仅精确匹配机器人显示名） */
export function extractWecomMentions(text: string, botName?: string): string[] {
  const out: string[] = [];
  const atRe = /[@＠]/g;
  const normBot = botName?.replace(/\s+/g, "").toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = atRe.exec(text)) !== null) {
    const rest = text.slice(m.index + 1);
    if (normBot) {
      // 精确匹配：跳过空白逐字符收集，收集长度对齐 normBot；去空白相等才算命中
      const name = matchAtName(rest, normBot);
      if (name) out.push(`@${name}`);
      continue;
    }
    const word = rest.match(/^[^\s，。！？!?]+/);
    if (word) out.push(`@${word[0]}`); // 未配置 botName → 宽松（S5：index 侧提示补配）
  }
  return out;
}

/** D2/A：@ 后收集到与 normBot 等长的去空白字符窗口（跳过空白），整体去空白一致才命中 */
function matchAtName(rest: string, normBot: string): string | undefined {
  let collected = "";
  let norm = 0;
  for (const ch of rest) {
    if (/\s/.test(ch)) {
      if (collected) collected += ch; // 名字内部空白保留（外部前导空白跳过）
      continue;
    }
    collected += ch;
    norm += 1;
    if (norm >= normBot.length) break;
  }
  const cand = collected.replace(/\s+/g, "").toLowerCase();
  return cand === normBot ? collected : undefined;
}

/** S5：首条群聊消息诊断日志消费（核对 botName 与企微后台显示名是否一致；进程内仅一次） */
let groupDiagLogged = false;
export function consumeWecomGroupDiag(): boolean {
  if (groupDiagLogged) return false;
  groupDiagLogged = true;
  return true;
}

export interface WecomInboundOptions {
  /** 群聊 @ 机器人显示名（D2/A；未配置维持宽松） */
  botName?: string;
}

/**
 * 企微消息回调 body → ParsedMessage；无法路由时返回 undefined。
 * 无 sender userid 或无可解析文本 → 返回 undefined。
 */
export function parseWecomInbound(body: WecomInboundBody | undefined, opts: WecomInboundOptions = {}): ParsedMessage | undefined {
  if (!body) return undefined;
  const messageId = body.msgid;
  const senderUserId = body.from?.userid;
  if (!messageId || !senderUserId) return undefined;

  const isGroup = body.chattype === "group";
  const chatId = isGroup ? (body.chatid ?? "") : senderUserId;
  if (!chatId) return undefined;

  const summarized = summarizeNonText(body.msgtype);
  const quoteText = extractWecomQuoteText(body);
  const mainText = extractWecomText(body);
  const rawText = quoteText ? `引用：${quoteText}\n${mainText}`.trim() : mainText;
  const finalText = summarized ?? rawText;
  if (!finalText.trim()) return undefined;

  const mentions = extractWecomMentions(finalText, opts.botName);

  return {
    messageId,
    chatId,
    chatType: isGroup ? "group" : "p2p",
    userId: senderUserId,
    text: finalText.trim(),
    rawText: finalText.trim(),
    mentions,
    platform: "wecom",
    timestamp: Number(body.create_time ?? Date.now()),
  };
}

/**
 * 判定 chatId 是否企微线路（用于 outbox 双路由 / StreamingCard 工厂分发）。
 * 飞书 chat_id / open_id 一律以 oc_/ou_/oi_/cli_ 等前缀开头；
 * 企微 userid / 群 chatid 为字母数字串，无此前缀。
 */
export function isWecomChatId(chatId: string): boolean {
  return !/^(oc_|ou_|oi_|cli_)/.test(chatId);
}
