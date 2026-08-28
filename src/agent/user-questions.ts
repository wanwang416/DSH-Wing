/**
 * ask-user-question 飞书桥 — M3 任务 1（🔴 阻塞项）
 *
 * 机制：monkey-patch `ctx.userQuestions.ask`（不占用 provider 名额，绕开 host-apiproxy
 * 已注册的 Web provider，避免 DUPLICATE_PROVIDER）。sessionId 前缀 `feishu:` 的 agent
 * 提问走飞书交互式卡片；其余转发原 ask（Web UI 提问不受影响）。
 *
 * 参考成熟桥接实现：
 * - sendAskQuestionPrompt (core/engine.go:11546)：单选按钮 / 多选编号列表
 * - resolveAskQuestionAnswer (core/engine.go:3481)：数字 / 选项文字解析
 * - onCardAction askq 处理 (platform/feishu/feishu.go:817)：✅ 已选择卡片更新
 * - renderCardMap (platform/feishu/card.go:91)：飞书卡片结构（header.title 用 plain_text）
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionBridgeDeps {
  /** 发送交互式卡片（schema 2.0）→ 返回 SDK 响应 */
  sendCard(chatId: string, card: unknown): Promise<unknown>;
  /** 更新已发送卡片（✅ 已选择） */
  updateCard(messageId: string, cardJson: string): Promise<unknown>;
  /** 发送普通文本（降级 / 无选项自由回答） */
  sendText(chatId: string, text: string): Promise<unknown>;
  /** 从 sendCard 响应提取 message_id */
  messageIdOf(res: unknown): string | undefined;
  /** 提问超时（默认 30_000ms） */
  timeoutMs?: number;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
}

/** DSH 错误码对齐（dsh-user-questions/lib/index.js: ASK_ABORTED / ASK_MISSING_AGENT） */
export class UserQuestionBridgeError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UserQuestionBridgeError";
    this.code = code;
  }
}

export const ASK_ABORTED = "ASK_ABORTED";
export const ASK_MISSING_AGENT = "ASK_MISSING_AGENT";

interface PendingEntry {
  chatId: string;
  question: PendingQuestion;
  resolve: (ans: { id: string; selected: string[]; custom?: string }) => void;
  reject: (err: Error) => void;
  cardMessageId?: string;
  mode: "card" | "text";
  timer?: ReturnType<typeof setTimeout>;
}

/** 提取 sendCard 响应中的 message_id（兼容 SDK 多种返回） */
export function messageIdOfRes(res: unknown): string | undefined {
  if (res && typeof res === "object") {
    const r = res as { data?: { message_id?: unknown; item?: { message_id?: unknown } }; message_id?: unknown };
    return (r?.data?.message_id ?? r?.message_id ?? r?.data?.item?.message_id) as string | undefined;
  }
  return undefined;
}

/**
 * ★ M4-R3 任务 2：描述卡片发送失败原因（降级可解释）。
 * axios 错误带 response：格式 `(400): code=xxx msg=xxx`（飞书拒绝 body 的 code/msg）。
 * 无 response（网络/超时等）：回退 err.message / 字符串化。
 */
export function describeSendError(err: unknown): string {
  const resp = (err as { response?: { status?: number; data?: unknown } })?.response;
  if (resp) {
    const d = resp.data as { code?: unknown; msg?: unknown } | undefined;
    if (d && typeof d === "object" && (d.code !== undefined || d.msg !== undefined)) {
      return `(${resp.status ?? "?"}): code=${d.code ?? "?"} msg=${d.msg ?? "?"}`;
    }
    return `(${resp.status ?? "?"}): ${JSON.stringify(resp.data).slice(0, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** 构建提问卡片（schema 2.0：单选按钮 / 多选编号列表 / 底部「其他反馈」输入框） */
export function buildQuestionCard(q: PendingQuestion): Record<string, unknown> {
  const opts = q.options ?? [];
  const body: Record<string, unknown>[] = [];
  body.push({ tag: "markdown", content: `**${q.question}**${q.detail ? `\n\n${q.detail}` : ""}` });

  let actions: Record<string, unknown>[] = [];
  if (q.multiSelect) {
    // 多选：编号列表，用户文本回复数字（对齐基底 sendAskQuestionPrompt 多选分支）
    body.push({
      tag: "markdown",
      content:
        opts.length > 0
          ? opts.map((o, i) => `${i + 1}. **${o.label}**${o.description ? " — " + o.description : ""}`).join("\n")
          : "（无预设选项，直接回复你的答案）",
    });
    // ★ M4-R4 修复（现象 2）：schema 2.0 不再支持 note 组件（报错 200861 → 卡片 400 必降级），改 markdown 提示
    body.push({ tag: "markdown", content: "请回复数字，多个用逗号分隔（如 1,3），或用下方输入框提交其他回答" });
  } else {
    // 单选：每选项一个按钮（对齐基底 sendAskQuestionPrompt 单选分支 / onCardAction）
    // ★ M3 根因修复：schema 2.0 按钮回调必须用 behaviors[{type:'callback',value}]，
    //   旧版 name+value 字段在 schema 2.0 下不触发 card.action.trigger 事件（参考 dsh-im feishu-cards.mjs）
    actions = opts.map((o, i) => ({
      tag: "button",
      type: "default",
      width: "fill",
      text: { tag: "plain_text", content: o.label },
      behaviors: [{
        type: "callback",
        value: { action: `answer:${q.id}:${i}`, questionId: q.id, optionId: i, label: o.label },
      }],
    }));
    if (actions.length === 0) {
      // ★ M4-R4 修复（现象 2）：note → markdown
      body.push({ tag: "markdown", content: "请直接回复你的答案，或用下方输入框提交" });
    }
  }

  // ★ M4-R4 修复（现象 3）：卡片内置「其他反馈」输入框（form + input + 提交按钮）——
  //   用户不选选项也能在卡片内直接输入回答（内置插话，直接命中 agent）。
  //   提交回调走 feedback: 前缀，用户输入在 action.form_values.free_text。
  const form: Record<string, unknown> = {
    tag: "form",
    name: `ask_feedback_${q.id}`,
    elements: [
      {
        tag: "input",
        name: "free_text",
        label: { tag: "plain_text", content: "💬 其他反馈" },
        placeholder: { tag: "plain_text", content: "不选上面选项，直接输入你的回答" },
      },
      {
        tag: "button",
        type: "primary",
        width: "fill",
        text: { tag: "plain_text", content: "提交反馈" },
        // ★ M4-R4 修复（真机两连回归）：form 内按钮声明提交事件用**按钮顶层字段**
        //   action_type: "form_submit"（schema 2.0 官方字段），不是 behaviors 里的 form_action。
        //   - 第一次只用 callback → 300123 there is no submit button in the form container
        //   - 第二次补 behaviors form_action → 200621 unknown behavior type（发送通道解析器不认识）
        //   action_type: form_submit = 绑定表单提交（点击回调带 action.form_values）；
        //   behaviors callback = 携带识别用的 action 名（feedback:<qid>）。
        action_type: "form_submit",
        behaviors: [{ type: "callback", value: { action: `feedback:${q.id}` } }],
      },
    ],
  };

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `❓ ${q.header ?? "请选择"}` }, template: "blue" },
    body: { elements: [...body, ...actions, form] },
  };
}

/** 构建"✅ 已选择"卡片（点击后替换原卡片，对齐基底 onCardAction 返回卡片） */
export function buildAnsweredCard(q: PendingQuestion, answerText: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `✅ ${answerText}` }, template: "green" },
    body: {
      elements: [{ tag: "markdown", content: `**${q.question}**\n\n→ **${answerText}**` }],
    },
  };
}

/** 降级文本提问（卡片发送失败时用） */
export function buildQuestionText(q: PendingQuestion): string {
  const opts = q.options ?? [];
  const sb = [`❓ ${q.question}`];
  if (q.detail) sb.push("", q.detail);
  if (opts.length > 0) {
    sb.push("", opts.map((o, i) => `${i + 1}. ${o.label}`).join("\n"), "", q.multiSelect ? "请回复数字，多个用逗号分隔（如 1,3）" : "请回复数字或选项文字");
  } else {
    sb.push("", "请直接回复你的答案");
  }
  return sb.join("\n");
}

/** 解析文本回复为选项（对齐基底 resolveAskQuestionAnswer：数字 / 逗号分隔 / 选项文字 / 自由文本） */
export function resolveTextAnswer(q: PendingQuestion, rawInput: string): { selected: string[]; custom?: string } {
  const input = rawInput.trim();
  const opts = q.options ?? [];
  if (opts.length === 0) {
    // 无预设选项 → 自由文本回答
    return input ? { selected: [], custom: input } : { selected: [] };
  }
  // 选项文字直接匹配
  const exact = opts.find((o) => o.label === input);
  if (exact) return { selected: [exact.label] };
  // 数字 / 逗号分隔（多选）
  const parts = input.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const labels: string[] = [];
  let allNumeric = true;
  for (const p of parts) {
    const idx = Number(p);
    if (!Number.isInteger(idx) || idx < 1 || idx > opts.length) {
      allNumeric = false;
      break;
    }
    labels.push(opts[idx - 1].label);
  }
  if (allNumeric && labels.length > 0) return { selected: labels };
  return { selected: [] };
}

/**
 * ★ M4-R4 修复（现象 3）：从卡片 form 提交回调提取用户自由文本。
 * 飞书 schema 2.0 form 提交 → 回调携带 action.form_values = { [input.name]: 值 }。
 * 优先取 free_text 字段，兜底任意第一个非空字符串值（兼容不同 input 命名）。
 */
export function extractFeedbackText(formValues: unknown): string {
  if (!formValues || typeof formValues !== "object") return "";
  const fv = formValues as Record<string, unknown>;
  for (const key of ["free_text", "text", "value"]) {
    const v = fv[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(fv)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function createUserQuestionBridge(deps: UserQuestionBridgeDeps) {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? 30_000;

  function timeout(chatId: string, entry: PendingEntry): void {
    if (pending.get(chatId) !== entry) return;
    pending.delete(chatId);
    entry.reject(new UserQuestionBridgeError("ask_user_question was aborted before the user answered", ASK_ABORTED));
  }

  function resolveEntry(chatId: string, entry: PendingEntry, selected: string[], custom?: string): boolean {
    if (pending.get(chatId) !== entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(chatId);
    entry.resolve({ id: entry.question.id, selected, ...(custom !== undefined ? { custom } : {}) });
    return true;
  }

  /** ★ M4-R4 修复（现象 3）：卡片「其他反馈」提交 → 自由文本作为 custom 答案 resolve 待答问题 */
  function handleFeedback(chatId: string, actionName: string, formValues: unknown): boolean {
    const entry = pending.get(chatId);
    if (!entry) {
      deps.logger?.warn?.(`onCardAction(feedback): pending 中找不到 chatId=${chatId}，pendingKeys=[${[...pending.keys()].join(",")}]`);
      return false;
    }
    const qid = actionName.split(":")[1];
    if (qid && qid !== entry.question.id) {
      deps.logger?.warn?.(`onCardAction(feedback): qid 不匹配，qid=${qid} 期望=${entry.question.id}`);
      return false;
    }
    const text = extractFeedbackText(formValues);
    if (!text) {
      deps.sendText(chatId, "⚠️ 反馈框是空的，请输入内容后提交").catch(() => void 0);
      return true;
    }
    if (!resolveEntry(chatId, entry, [], text)) {
      deps.logger?.warn?.(`onCardAction(feedback): resolveEntry 失败（entry 已过期）`);
      return true;
    }
    if (entry.cardMessageId) {
      deps.updateCard(entry.cardMessageId, JSON.stringify(buildAnsweredCard(entry.question, text))).catch(() => void 0);
    }
    deps.logger?.info?.(`提问卡片自由反馈 chat=${chatId} q=${entry.question.id} → ${text}`);
    return true;
  }

  async function trySendCard(chatId: string, entry: PendingEntry): Promise<void> {
    try {
      const res = await deps.sendCard(chatId, buildQuestionCard(entry.question));
      entry.cardMessageId = deps.messageIdOf(res);
      entry.mode = "card";
      // ★ 修复：卡片发送成功后才启动超时计时器，避免发送过程中就超时
      entry.timer = setTimeout(() => timeout(chatId, entry), timeoutMs);
      deps.logger?.info?.(`提问卡片已发送 chat=${chatId} q=${entry.question.id} mode=card`);
    } catch (err) {
      entry.mode = "text";
      // ★ M4-R3 任务 2：400 盲降级修复——不再只打 err.message（axios 状态行）。
      //   提取飞书拒绝原因（axios 错误 response.status + response.data 的 code/msg），
      //   降级必须可解释：每次降级日志都能看到飞书给的拒绝理由。
      deps.logger?.warn?.(`提问卡片发送失败，降级文本 ${describeSendError(err)}`);
      try {
        // 降级文本也需要启动计时器
        await deps.sendText(chatId, buildQuestionText(entry.question));
        entry.timer = setTimeout(() => timeout(chatId, entry), timeoutMs);
      } catch (err2) {
        deps.logger?.warn?.(`提问文本降级也失败（将超时兜底）: ${err2 instanceof Error ? err2.message : String(err2)}`);
      }
    }
  }

  function askOne(
    chatId: string,
    request: { signal?: AbortSignal },
    question: PendingQuestion,
  ): Promise<{ id: string; selected: string[]; custom?: string }> {
    return new Promise((resolve, reject) => {
      if (pending.has(chatId)) {
        reject(new UserQuestionBridgeError("已有待答问题（chat busy）", "DUPLICATE_QUESTION"));
        return;
      }
      const entry: PendingEntry = { chatId, question, resolve, reject, mode: "card" };
      pending.set(chatId, entry);
      // ★ 修复：计时器移到 trySendCard 卡片发送成功后再启动，避免发送过程中超时
      request.signal?.addEventListener("abort", () => timeout(chatId, entry), { once: true });
      void trySendCard(chatId, entry);
    });
  }

  return {
    /** 注册：monkey-patch ctx.userQuestions.ask（飞书优先，Web 转发原 provider）。返回恢复函数 */
    patchAsk(ctx: { userQuestions?: { ask: (...args: any[]) => Promise<unknown> } } | undefined): () => void {
      const uq = ctx?.userQuestions;
      if (!uq || typeof uq.ask !== "function") {
        deps.logger?.warn?.("ctx.userQuestions 不可用——ask-user-question 未接管");
        return () => {};
      }
      const originalAsk = uq.ask.bind(uq);
      uq.ask = (async (request: any) => {
        const sessionId = request?.agent?.id;
        const isFeishu = typeof sessionId === "string" && sessionId.startsWith("feishu:");
        if (!isFeishu) return originalAsk(request);
        const chatId = sessionId.slice("feishu:".length).split(":")[0];
        if (!chatId) throw new UserQuestionBridgeError("feishu session 解析失败", ASK_MISSING_AGENT);
        const answers: { id: string; selected: string[]; custom?: string }[] = [];
        for (const question of request?.questions ?? []) {
          answers.push(await askOne(chatId, request, question));
        }
        return { answers };
      }) as typeof uq.ask;
      deps.logger?.info?.("userQuestions.ask 已接管（飞书优先，Web 转发原 provider）");
      return () => {
        uq.ask = originalAsk;
      };
    },

    /**
     * 卡片按钮回调 → resolve 待答问题。
     * - answer: 前缀：单选按钮点击（对齐基底 onCardAction）
     * - feedback: 前缀：卡片内「其他反馈」输入框提交（★ M4-R4 现象 3），自由文本作为 custom 答案
     * @returns true=已消费（index.ts 不再 steer 注入）
     */
    onCardAction(chatId: string, actionName: string, formValues?: unknown): boolean {
      deps.logger?.info?.(`onCardAction 进入: chatId=${chatId} actionName=${actionName} formValues=${formValues ? JSON.stringify(formValues).slice(0, 200) : "undefined"} pendingSize=${pending.size}`);
      if (actionName?.startsWith("feedback:")) {
        return handleFeedback(chatId, actionName, formValues);
      }
      if (!actionName?.startsWith("answer:")) {
        deps.logger?.warn?.(`onCardAction: actionName 不以 answer:/feedback: 开头，actionName=${actionName}`);
        return false;
      }
      const entry = pending.get(chatId);
      if (!entry) {
        deps.logger?.warn?.(`onCardAction: pending 中找不到 chatId=${chatId}，pendingKeys=[${[...pending.keys()].join(",")}]`);
        return false;
      }
      const parts = actionName.split(":");
      if (parts.length < 3) {
        deps.logger?.warn?.(`onCardAction: actionName 格式错误，parts=${parts.join("|")}`);
        return false;
      }
      const optIdx = Number(parts[2]);
      const opt = entry.question.options?.[optIdx];
      if (!opt) {
        deps.logger?.warn?.(`onCardAction: 选项不存在，optIdx=${optIdx} optionsCount=${entry.question.options?.length ?? 0}`);
        return false;
      }
      if (!resolveEntry(chatId, entry, [opt.label])) {
        deps.logger?.warn?.(`onCardAction: resolveEntry 失败（entry 已过期）`);
        return true;
      }
      if (entry.cardMessageId) {
        deps.updateCard(entry.cardMessageId, JSON.stringify(buildAnsweredCard(entry.question, opt.label))).catch(() => void 0);
      }
      deps.logger?.info?.(`提问已回答 chat=${chatId} q=${entry.question.id} → ${opt.label}`);
      return true;
    },

    /**
     * 文本回复（多选 / 降级 / 自由文本）→ resolve 待答问题。
     * @returns true=已消费（index.ts 不再 steer 注入）
     */
    onTextInbound(chatId: string, text: string): boolean {
      const entry = pending.get(chatId);
      if (!entry) return false;
      const ans = resolveTextAnswer(entry.question, text);
      if (ans.selected.length === 0 && ans.custom === undefined) {
        // 解析不出 → 提示重试，消费该消息避免污染 agent
        deps.sendText(chatId, "⚠️ 没认出你的选项，请回复数字（如 1，多选用 1,3）或选项文字").catch(() => void 0);
        return true;
      }
      if (!resolveEntry(chatId, entry, ans.selected, ans.custom)) return true;
      const shown = ans.custom ?? ans.selected.join(", ");
      if (entry.cardMessageId) {
        deps.updateCard(entry.cardMessageId, JSON.stringify(buildAnsweredCard(entry.question, shown))).catch(() => void 0);
      }
      deps.logger?.info?.(`提问文本回答 chat=${chatId} q=${entry.question.id} → ${shown}`);
      return true;
    },
  };
}

export type UserQuestionBridge = ReturnType<typeof createUserQuestionBridge>;
