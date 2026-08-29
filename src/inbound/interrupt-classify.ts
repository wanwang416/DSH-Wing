/**
 * ★ ALAN 灵魂设计：任务中断四类分类（command/question/confirm/ordinary）
 *
 * 决策表（顺序严格：COMMAND → QUESTION → CONFIRM → ORDINARY → null）：
 *   COMMAND  (停/改道 → 立即中断)   停止词精确+包含；改道词
 *   QUESTION (疑问 → 不打断主任务) 前缀 为什么/怎么做/是什么/请问；精确 能解释一下吗/可以问一下吗
 *   CONFIRM  (拿不准 → 先确认)    包含 可以吗/这样对吗/这样行吗；精确 你确定/是不是/确认一下
 *   ORDINARY (回执)                纯确认词（仅回执）vs 推进词（followup 注入）
 *   null    （普通对话 → 走原 steer/followup 逻辑）
 *
 * 分类错误率硬门槛：24 条用例（每类 6 条）必须 100% 命中。
 */
export enum InterruptType {
  COMMAND = "command",
  QUESTION = "question",
  CONFIRM = "confirm",
  ORDINARY = "ordinary",
}

/** 停止词（精确匹配；含历史停止词 /stop/算了，兼容 P0-2 之前版本） */
const STOP_WORDS_EXACT = new Set(["停", "停止", "stop", "/stop", "算了"]);
/** 停止词（包含匹配，口语化） */
const STOP_WORDS_INCLUDE = ["停下来", "停一下", "别说了", "别写了", "不要说了"];
/** 改道词（先停，再注入新指令） */
const REDIRECT_WORDS = new Set(["换个话题", "重新来"]);

/** 疑问前缀（startsWith） */
const QUESTION_PREFIXES = ["为什么", "怎么做", "是什么", "请问"];
/** 疑问精确词 */
const QUESTION_EXACT = new Set(["能解释一下吗", "可以问一下吗"]);

/** 确认词（包含匹配：这样真的可以吗 / 你确定吗 也命中） */
const CONFIRM_WORDS = ["可以吗", "这样对吗", "这样行吗", "你确定", "是不是", "确认一下"];

/** 纯确认词（ORDINARY · 仅回执，不注入不打断） */
export const ORDINARY_ACK_WORDS = new Set(["嗯", "好的", "收到", "明白", "知道了"]);
/** 推进词（ORDINARY · followup 注入，豆包细分拍板：必须注入，否则任务卡死） */
export const ORDINARY_FORWARD_WORDS = new Set(["继续", "接着来", "往下"]);

/** normalize：trim + 小写（大小写不敏感，前后空白裁剪） */
function normalize(text: string): string {
  return (text ?? "").trim().toLowerCase();
}

/**
 * 分类任务中断类型。
 * @returns 四类之一；普通对话/空消息返回 null（走原 steer/followup 逻辑）。
 */
export function classifyInterrupt(text: string): InterruptType | null {
  const t = normalize(text);
  if (t === "") return null;

  // 1. COMMAND：停止词（精确/包含）+ 改道词
  if (
    STOP_WORDS_EXACT.has(t) ||
    STOP_WORDS_INCLUDE.some((w) => t.includes(w)) ||
    REDIRECT_WORDS.has(t)
  ) {
    return InterruptType.COMMAND;
  }

  // 2. QUESTION：前缀/精确（先于 CONFIRM，避免「可以问一下吗」被当作确认）
  if (QUESTION_EXACT.has(t) || QUESTION_PREFIXES.some((p) => t.startsWith(p))) {
    return InterruptType.QUESTION;
  }

  // 3. CONFIRM：包含确认词（含 …吗 后缀形态）
  if (CONFIRM_WORDS.some((w) => t.includes(w))) {
    return InterruptType.CONFIRM;
  }

  // 4. ORDINARY：纯确认词 + 推进词
  if (ORDINARY_ACK_WORDS.has(t) || ORDINARY_FORWARD_WORDS.has(t)) {
    return InterruptType.ORDINARY;
  }

  return null;
}

/** 是否改道词（COMMAND 子类：先 cancel，再 followup 注入新指令） */
export function isRedirectWord(text: string): boolean {
  return REDIRECT_WORDS.has(normalize(text));
}

/** 是否推进词（ORDINARY 子类：需要 followup 注入，不能只回执） */
export function isForwardWord(text: string): boolean {
  return ORDINARY_FORWARD_WORDS.has(normalize(text));
}
