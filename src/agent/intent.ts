/**
 * P1-3 意图桥：群聊消息意图路由（命令/提问/闲聊/任务）
 *
 * 定位：在 commandRouter（命令识别）之后、handleUserMessage（四类分类）之前，
 * 对**群聊**消息做「纯寒暄」过滤——避免 groupPolicy=open 时群里任何消息都进 agent。
 *
 * 规则（保守防误判，优先保证不吞真实任务）：
 *   classifyIntent 顺序：空→CHITCHAT；`/`前缀→COMMAND；疑问句式→QUESTION；
 *                        纯寒暄短消息→CHITCHAT；其余→TASK
 *   isChitchat：整句去除标点后 ≤20 字符且完全命中寒暄词表（含 呀/啊/啦 等后缀变体）；
 *               长句 / 含任务特征词一律不算 → 交给 agent
 *   p2p 永远不过滤（用户单独找 bot 必须有响应）；仅群聊 + 未明确 @bot 时过滤
 */

import { classifyInterrupt, InterruptType } from "../inbound/interrupt-classify.js";

export enum Intent {
  /** /xxx 命令（commandRouter 已拦截处理，意图桥仅为完整性返回） */
  COMMAND = "command",
  /** 疑问句式（问号 / 为什么 / …吗 / …呢 结尾） */
  QUESTION = "question",
  /** 纯寒暄短消息（群里无人提及的社交寒暄） */
  CHITCHAT = "chitchat",
  /** 其余：真实任务请求 */
  TASK = "task",
}

/** 分词：按空白/标点切 token（寒暄匹配用；中文连续无空格的长句按单个 token 处理） */
const TOKEN_SPLIT = /[\s，。！？!?,.、；;：:·~～()（）\[\]【】"'“”‘’]+/;

/** normalize：trim + 小写 */
function normalize(text: string): string {
  return (text ?? "").trim().toLowerCase();
}

/** 寒暄/社交词表（整句全命中才判 CHITCHAT；保守——只放明确无任务语义的词） */
const CHITCHAT_WORDS = new Set([
  "你好", "您好", "哈喽", "hello", "hi", "嗨",
  "早上好", "下午好", "晚上好", "早安", "晚安",
  "在吗", "在不在", "有人吗", "还在吗",
  "谢谢", "感谢", "辛苦", "辛苦了", "辛苦啦",
  "哈哈", "呵呵", "嘿嘿", "嘿嘿嘿", "666", "6", "赞",
  "好的", "好", "嗯", "嗯嗯", "收到", "明白", "明白了", "知道了",
  "再见", "拜拜", "加油", "厉害", "牛", "棒", "可以", "行",
  "ok", "okk", "okay", "yes", "no",
  "测试", "测试一下", "test",
  "无聊", "没事", "没事了",
]);

/** 寒暄词后缀变体（你好呀 / 好的啦 / 谢谢啊） */
const CHITCHAT_SUFFIX = ["呀", "啊", "啦", "哦", "呢", "哈", "咯", "嘞"];

/** 单 token 是否命中寒暄（词表精确 或 词+后缀变体） */
function isChitchatToken(t: string): boolean {
  if (!t || t.length > 20) return false;
  if (CHITCHAT_WORDS.has(t)) return true;
  return [...CHITCHAT_WORDS].some((w) => CHITCHAT_SUFFIX.some((s) => t === w + s));
}

/**
 * 整句是否纯寒暄（保守防误判）：
 * - 按空格/标点切 token，1~3 个 token，且**每个** token 都命中寒暄词表
 * - 长句 / 含任务词 → 不算
 */
export function isChitchat(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const tokens = t.split(TOKEN_SPLIT).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every(isChitchatToken);
}

/** 疑问句式（问号 / 疑问前缀 / …吗 / …呢 / 疑问代词） */
const QUESTION_PREFIXES = ["为什么", "怎么做", "是什么", "请问", "咋", "啥叫", "什么叫"];
const QUESTION_RE = /[?？]|吗$|呢$|哪里|哪儿|哪个|哪些|什么|怎么|几点|多少|能不能|可不可以|行不行|对不对/;

export function isQuestionLike(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  // 寒暄（在吗/谢谢/哈哈）不是提问
  if (isChitchat(t)) return false;
  if (QUESTION_PREFIXES.some((p) => t.startsWith(p))) return true;
  return QUESTION_RE.test(t);
}

/**
 * 意图分类（顺序严格：空→CHITCHAT；命令→COMMAND；疑问→QUESTION；寒暄→CHITCHAT；其余→TASK）。
 * 与 P0-1 四类分类（classifyInterrupt）配合：这里只做「是否值得触发 agent」的粗分流。
 */
export function classifyIntent(text: string): Intent {
  const t = (text ?? "").trim();
  if (!t) return Intent.CHITCHAT;
  if (t.startsWith("/")) return Intent.COMMAND;
  // 精确疑问前缀（为什么/怎么做/是什么/请问）→ QUESTION（四类分类权威）
  if (classifyInterrupt(t) === InterruptType.QUESTION) return Intent.QUESTION;
  // 纯寒暄先于宽泛疑问判定（「在吗/在不在」是招呼不是提问）
  if (isChitchat(t)) return Intent.CHITCHAT;
  // 宽泛疑问句式（问号 / …吗 / …呢 / 疑问代词）→ QUESTION
  if (isQuestionLike(t)) return Intent.QUESTION;
  return Intent.TASK;
}
