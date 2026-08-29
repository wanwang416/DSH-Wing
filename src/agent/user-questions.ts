/**
 * ask-user-question 飞书桥 — M3 任务 1（🔴 阻塞项）
 *
 * 机制：monkey-patch `ctx.userQuestions.ask`（不占用 provider 名额，绕开 host-apiproxy
 * 已注册的 Web provider，避免 DUPLICATE_PROVIDER）。sessionId 前缀 `feishu:` 的 agent
 * 提问走飞书交互式卡片；其余转发原 ask（Web UI 提问不受影响）。
 *
 * 参考成熟桥接实现：
 * - sendAskQuestionPrompt：单选按钮 / 多选编号列表
 * - resolveAskQuestionAnswer：数字 / 选项文字解析
 * - onCardAction askq 处理：✅ 已选择卡片更新
 * - renderCardMap：飞书卡片结构（header.title 用 plain_text）
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
  /** card=按钮卡片待答 / text=文本降级待答 / freeText=用户点了"自由输入"按钮，等待文本回答 */
  mode: "card" | "text" | "freeText";
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
    body.push({ tag: "markdown", content: "请回复数字，多个用逗号分隔（如 1,3），或直接回复你的答案" });
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
      body.push({ tag: "markdown", content: "请直接回复你的答案" });
    } else {
      // ★ M4 终审风险1：单选有选项时，底部加「自由输入」按钮——用户不想选选项时可以打字回答
      //   （Q3 输入缺口修复：callback 引导打字，对齐 M5-plan.md 候选项方案）
      actions.push({
        tag: "button",
        type: "primary",
        width: "fill",
        text: { tag: "plain_text", content: "✏️ 我想自由输入" },
        behaviors: [{
          type: "callback",
          value: { action: `free_text:${q.id}`, questionId: q.id, mode: "freeText" },
        }],
      });
    }
  }

  // ★ M4-R4 灾难回退（2026-08-28）：form 容器在 im 直发通道（sendCard）下无法声明提交按钮
  //   （300123→200621→300123 三连败，见 Obsidian 灾难记录），整个 form 移除。
  //   现象 3「卡片内插话」留 M5 用非 form 方案（callback 按钮引导打字）。
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `❓ ${q.header ?? "请选择"}` }, template: "blue" },
    body: { elements: [...body, ...actions] },
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

/** ★ M4 终审风险1：用户点了「自由输入」按钮后替换原卡片，提示直接打字回答 */
export function buildFreeTextPromptCard(q: PendingQuestion): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `✏️ ${q.header ?? "自由输入"}` }, template: "turquoise" },
    body: {
      elements: [
        { tag: "markdown", content: `**${q.question}**${q.detail ? `\n\n${q.detail}` : ""}` },
        { tag: "markdown", content: "请直接输入你的回答（发送后即提交），不想回答了可以发「停止」或「算了」。" },
      ],
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

/**
 * ★ M4 终审风险1：停止词检测（与 experience.ts handleUserMessage 的停止词表保持同步）。
 * 提问 pending 期间用户发停止词 → onTextInbound 先 abort pending 再返回 false，
 * 让消息继续走正常 handleUserMessage 流程，由 experience.ts 统一 agent.cancel()。
 */
export function isStopWord(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === "停" ||
    t === "停止" ||
    t === "stop" ||
    t === "/stop" ||
    t.includes("停下来") ||
    t.includes("停一下") ||
    t.includes("别说了") ||
    t.includes("别写了") ||
    t.includes("不要说了") ||
    t === "算了"
  );
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

export function createUserQuestionBridge(deps: UserQuestionBridgeDeps) {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? 30_000;

  function timeout(chatId: string, entry: PendingEntry): void {
    if (pending.get(chatId) !== entry) return;
    pending.delete(chatId);
    // ★ R5.1：过期必须留痕——此前静默删除，用户稍后点击只看到 pendingKeys=[]，无法归因
    deps.logger?.warn?.(
      `提问待答窗口已超时（${timeoutMs}ms），pending 已清除：chat=${chatId} q=${entry.question.id}；用户稍后点击将走 steer 兜底`,
    );
    entry.reject(new UserQuestionBridgeError("ask_user_question was aborted before the user answered", ASK_ABORTED));
  }

  function resolveEntry(chatId: string, entry: PendingEntry, selected: string[], custom?: string): boolean {
    if (pending.get(chatId) !== entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(chatId);
    entry.resolve({ id: entry.question.id, selected, ...(custom !== undefined ? { custom } : {}) });
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
     * 卡片按钮回调 → resolve 待答问题（answer: 前缀 = 选项按钮点击）。
     * @returns true=已消费（index.ts 不再 steer 注入）
     */
    onCardAction(chatId: string, actionName: string): boolean {
      deps.logger?.info?.(`onCardAction 进入: chatId=${chatId} actionName=${actionName} pendingSize=${pending.size}`);

      // ★ M4 终审风险1：用户点了「自由输入」按钮 → 切换到 freeText 模式，更新卡片提示直接打字
      if (actionName?.startsWith("free_text:")) {
        const entry = pending.get(chatId);
        if (!entry) {
          deps.logger?.warn?.(`onCardAction free_text: pending 中找不到 chatId=${chatId}`);
          return false;
        }
        entry.mode = "freeText";
        // 重置计时器：用户主动交互后重新开始计时，避免刚切到自由输入就超时
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => timeout(chatId, entry), timeoutMs);
        if (entry.cardMessageId) {
          deps.updateCard(entry.cardMessageId, JSON.stringify(buildFreeTextPromptCard(entry.question))).catch(() => void 0);
        }
        deps.logger?.info?.(`提问已切换到自由输入模式: chat=${chatId} q=${entry.question.id}`);
        return true;
      }

      if (!actionName?.startsWith("answer:")) {
        deps.logger?.warn?.(`onCardAction: actionName 不以 answer: 开头，actionName=${actionName}`);
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
      // ★ M4 终审风险1：停止词优先——提问 pending 期间用户发"停下来/别写了"等，
      //   先 abort pending（清计时器+reject），再返回 false 让消息走正常 handleUserMessage，
      //   由 experience.ts 统一 agent.cancel()。停止词表与 experience.ts 保持同步。
      if (isStopWord(text)) {
        if (pending.has(chatId)) {
          this.abortByChatId(chatId, "user_stop");
          deps.logger?.info?.(`提问 pending 期间收到停止词，已 abort 并放行消息：chat=${chatId} text="${text.slice(0, 30)}"`);
        }
        return false; // 不消费，让正常流程处理 agent.cancel
      }
      const entry = pending.get(chatId);
      if (!entry) return false;

      // ★ M4 终审风险1：freeText 模式（用户点了「自由输入」按钮）→ 直接接受文本作为 custom answer，不做选项解析
      if (entry.mode === "freeText") {
        const trimmed = text.trim();
        if (!trimmed) {
          deps.sendText(chatId, "请输入你的回答（空内容无法提交）").catch(() => void 0);
          return true;
        }
        if (!resolveEntry(chatId, entry, [], trimmed)) return true;
        if (entry.cardMessageId) {
          deps.updateCard(entry.cardMessageId, JSON.stringify(buildAnsweredCard(entry.question, trimmed))).catch(() => void 0);
        }
        deps.logger?.info?.(`提问自由文本回答 chat=${chatId} q=${entry.question.id} → ${trimmed.slice(0, 50)}`);
        return true;
      }

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

    /**
     * ★ M4 终审风险2：agent dispose/turnTimeout 时主动 abort 该 chat 的 pending，
     * 避免用户稍后点击按钮时 steer 注入失败（agent 已不存在）。
     * @returns true=有 pending 被 abort，false=该 chat 无 pending
     */
    abortByChatId(chatId: string, reason = "agent_disposed"): boolean {
      const entry = pending.get(chatId);
      if (!entry) return false;
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(chatId);
      deps.logger?.info?.(`提问 pending 已主动 abort（${reason}）：chat=${chatId} q=${entry.question.id}`);
      entry.reject(new UserQuestionBridgeError(`ask_user_question aborted: ${reason}`, ASK_ABORTED));
      return true;
    },

    /** 桥停止时 abort 所有 pending（避免残留 Promise 悬挂） */
    abortAll(): number {
      let count = 0;
      for (const chatId of [...pending.keys()]) {
        if (this.abortByChatId(chatId, "bridge_stopped")) count++;
      }
      return count;
    },
  };
}

export type UserQuestionBridge = ReturnType<typeof createUserQuestionBridge>;
