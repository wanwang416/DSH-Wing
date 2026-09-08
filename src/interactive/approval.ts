/**
 * P1-1 审批卡（危险操作审批；ALAN 拍板④：仅老板本人可点）
 *
 * DSH approval 机制（@deepseek-ai/dsh-user-approval d.ts 权威，铁律 8）：
 * - `ctx.on("approval/request", (req, next))` waterfall：返回 outcome 认领，或调 next() 让后续 answerer
 * - `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（'allowed-once' 是唯一 grant）
 * - 审批发生在 tool call 前（turn open），天然满足「approval/request 需 open turn」
 *
 * 流程：
 *   1) approval/request 到达（agent.id 以 feishu: 前缀 = 本插件 agent）
 *   2) 查记忆：Always / Session 命中 → 直接 'allowed-once'（不发卡）
 *   3) 无记忆 → 发审批卡（四按钮）→ 用户点击 `approval:<entryId>:<decision>`
 *   4) 老板限定校验（拍板④）：点击者 open_id 必须 === bossOpenId（配置时）；非老板 → 'rejected'
 *   5) resolve pending → answerer 返回 outcome（Allow Once→allowed-once / Deny→rejected /
 *      Session→会话级记忆+allowed-once / Always→落盘记忆+allowed-once）
 *
 * 超时 / signal abort → 'cancelled'（fail-closed，不误放行）。
 */

import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";

export interface ApprovalMemoryDeps {
  file: string;
}

/** 审批记忆（Session 内存 / Always 落盘 JSON，键 = "chatId:toolName"） */
export function createApprovalMemory(deps: ApprovalMemoryDeps) {
  // Session 记忆（进程内存）：本会话同 toolName 不再弹
  const session = new Set<string>();
  // Always 记忆（落盘）：重启保留
  let always = new Map<string, Set<string>>();
  try {
    const raw = readFileSync(deps.file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    always = new Map(Object.entries(parsed).map(([k, v]) => [k, new Set(v)]));
  } catch {
    always = new Map();
  }
  const persist = (): void => {
    try {
      writeFileSync(deps.file, JSON.stringify(Object.fromEntries([...always].map(([k, v]) => [k, [...v]])), null, 2), { mode: 0o600 });
    } catch {
      // 忽略
    }
  };
  const key = (chatId: string, toolName: string): string => `${chatId}:${toolName}`;
  return {
    shouldAutoAllow(chatId: string, toolName: string): boolean {
      const k = key(chatId, toolName);
      return session.has(k) || always.get(k) !== undefined;
    },
    addSession(chatId: string, toolName: string): void {
      session.add(key(chatId, toolName));
    },
    addAlways(chatId: string, toolName: string): void {
      const k = key(chatId, toolName);
      const set = always.get(k) ?? new Set<string>();
      set.add(toolName);
      always.set(k, set);
      persist();
    },
  };
}

export type ApprovalMemory = ReturnType<typeof createApprovalMemory>;

/** 审批卡回调 op 前缀（event-handler 分发用） */
export const APPROVAL_OP_PREFIX = "approval:";

export interface ApprovalBridgeDeps {
  /** 发审批卡（Bug3b 起直发 sender.sendCard → 返回 SDK 响应以取 message_id；原 outbox 已弃） */
  sendCard(chatId: string, card: Record<string, unknown>): Promise<unknown>;
  /** 更新已发送审批卡（决策/超时后收口换状态卡，Bug3b） */
  updateCard(messageId: string, cardJson: string): Promise<unknown>;
  /** 从 sendCard 响应提取 message_id（对齐提问桥 messageIdOf，Bug3b） */
  messageIdOf(res: unknown): string | undefined;
  /** 审批结果回执（拒绝/超时提示，outbox text） */
  sendText(chatId: string, text: string): unknown;
  /** 老板 open_id（WingConfig.bossOpenId；未配置 → 单用户宽松 + warn 一次，拍板④强校验依赖配置） */
  bossOpenId?: string;
  /** 审批超时 ms（默认 turnTimeoutMs 同源；超时 → cancelled） */
  timeoutMs?: number;
  logger?: { info?(m: string): void; warn?(m: string): void };
  /** Always 记忆落盘文件 */
  memoryFile: string;
}

interface PendingEntry {
  chatId: string;
  toolName: string;
  settle: (outcome: ApprovalOutcome) => void;
}

/** 构建审批卡（schema 2.0：说明 + 四按钮，op = approval:<entryId>:<decision>） */
export function buildApprovalCard(opts: { entryId: string; toolName: string; reason?: string; bossOpenId?: string }): Record<string, unknown> {
  const bossNote = opts.bossOpenId ? `\n🔐 仅限老板本人操作。` : "";
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: `⚠️ **${opts.toolName}** 请求执行\n\n${opts.reason ?? "（无说明）"}\n\n请决定是否放行：${bossNote}`,
    },
    {
      tag: "button", type: "primary", width: "fill",
      text: { tag: "plain_text", content: "✅ Allow Once（仅本次）" },
      behaviors: [{ type: "callback", value: { op: `approval:${opts.entryId}:allow-once` } }],
    },
    {
      tag: "button", type: "default", width: "fill",
      text: { tag: "plain_text", content: "🕐 Session（本会话不再问）" },
      behaviors: [{ type: "callback", value: { op: `approval:${opts.entryId}:session` } }],
    },
    {
      tag: "button", type: "default", width: "fill",
      text: { tag: "plain_text", content: "♾️ Always（永久放行）" },
      behaviors: [{ type: "callback", value: { op: `approval:${opts.entryId}:always` } }],
    },
    {
      tag: "button", type: "danger", width: "fill",
      text: { tag: "plain_text", content: "❌ Deny（拒绝）" },
      behaviors: [{ type: "callback", value: { op: `approval:${opts.entryId}:deny` } }],
    },
  ];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🔓 操作审批" }, template: "orange" },
    body: { elements },
  };
}

/** 构建审批「收口」状态卡（Bug3b：决策/超时后替换原四按钮卡，不再停留在可操作界面） */
export function buildApprovalSettledCard(opts: { toolName: string; outcome: ApprovalOutcome }): Record<string, unknown> {
  const table: Record<ApprovalOutcome, { emoji: string; title: string; template: string; body: string }> = {
    "allowed-once": { emoji: "✅", title: "已允许", template: "green", body: `已放行 **${opts.toolName}** 本次执行。` },
    rejected: { emoji: "❌", title: "已拒绝", template: "red", body: `已拒绝 **${opts.toolName}** 执行。` },
    cancelled: { emoji: "⏰", title: "已失效", template: "grey", body: `**${opts.toolName}** 请求已失效（超时或中断）。` },
    unavailable: { emoji: "⚠️", title: "发送失败", template: "red", body: `审批卡发送失败，**${opts.toolName}** 请求未放行（fail-closed）。` },
  };
  const m = table[opts.outcome];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `${m.emoji} 操作审批 · ${m.title}` }, template: m.template },
    body: { elements: [{ tag: "markdown", content: m.body }] },
  };
}

/** 从 agent.id 反推 chatId（本插件 sessionId = feishu:<chatId>:<runNonce>:<gen>）；非本插件 → undefined */
export function chatIdFromAgentId(agentId: string): string | undefined {
  if (!agentId.startsWith("feishu:")) return undefined;
  return agentId.slice("feishu:".length).split(":")[0] || undefined;
}

export function createApprovalBridge(deps: ApprovalBridgeDeps) {
  const pending = new Map<string, PendingEntry>();
  const memory = createApprovalMemory({ file: deps.memoryFile });
  let entryCounter = 0;
  let bossWarned = false;

  /** 老板限定（拍板④）：配置 bossOpenId → 点击者必须匹配；未配置 → 单用户宽松 + warn 一次 */
  const isBoss = (openId: string | undefined): boolean => {
    if (deps.bossOpenId) return openId === deps.bossOpenId;
    if (!bossWarned) {
      deps.logger?.warn?.("审批卡未配置 bossOpenId——老板限定未生效（群聊他人可点）。建议在 config.json 配置 WING_LARK_APP 老板 open_id。");
      bossWarned = true;
    }
    return true;
  };

  /** approval/request answerer（waterfall）：返回 outcome 认领，非本插件 agent → next() */
  async function answer(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatId = req.agent?.id ? chatIdFromAgentId(req.agent.id) : undefined;
    if (!chatId) return next(); // 非本插件 agent，让其他 answerer

    // 记忆命中（Always/Session）→ 直接放行，不发卡
    if (memory.shouldAutoAllow(chatId, req.toolName)) {
      deps.logger?.info?.(`审批记忆命中（always）chat=${chatId} tool=${req.toolName} → allowed-once`);
      return "allowed-once";
    }

    // 无记忆 → 发审批卡，等用户决策（超时/abort → cancelled，fail-closed）
    return await new Promise<ApprovalOutcome>((resolve) => {
      const entryId = `a${++entryCounter}_${Date.now()}`;
      const toolName = req.toolName;
      let settled = false;
      // ★ Bug3b：记录已发卡 message_id，供 settle 决策后 updateCard 收口换状态卡
      let sentCardMessageId: string | undefined;
      // timer 先声明（settle 闭包引用；TDZ 安全——settle 只在事件回调/超时/abort 时被调，彼时已赋值）
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        pending.delete(entryId);
        // ★ Bug3b：收口——把原四按钮卡替换成状态卡（✅已允许/❌已拒绝/⏰已失效），不再停留可操作界面
        if (sentCardMessageId) {
          void deps
            .updateCard(sentCardMessageId, JSON.stringify(buildApprovalSettledCard({ toolName, outcome })))
            .catch(() => void 0);
        }
        resolve(outcome);
      };
      const entry: PendingEntry = { chatId, toolName, settle };
      pending.set(entryId, entry);

      // timer 与 abort listener 同步挂好（不依赖 sendCard resolve：
      //   ① abort 即时性——signal abort 在发送完成前也能取消，fail-closed；
      //   ② 超时窗口含发送过程，维持原「发卡后立即计时」语义）
      timer = setTimeout(() => settle("cancelled"), deps.timeoutMs ?? 300_000);
      timer.unref?.();
      req.signal?.addEventListener("abort", () => settle("cancelled"), { once: true });
      try {
        // Bug3b：审批卡直发 sender.sendCard → resolve 后捕获 message_id，供 settle 决策后收口换状态卡
        void deps
          .sendCard(chatId, buildApprovalCard({ entryId, toolName, reason: req.reason, bossOpenId: deps.bossOpenId }))
          .then((res) => {
            sentCardMessageId = deps.messageIdOf(res);
          })
          .catch((err) => {
            // 发卡失败 → fail-closed（settle 幂等：超时/abort 先触发则不覆盖）
            deps.logger?.warn?.(`审批卡发送失败 chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`);
            settle("unavailable");
          });
      } catch (err) {
        // 防御：同步 throw（如 mock 同步抛）→ fail-closed
        deps.logger?.warn?.(`审批卡发送同步异常 chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`);
        settle("unavailable");
      }
    });
  }

  /**
   * 审批卡回调（event-handler op 路由：approval:<entryId>:<decision>）。
   * @param operatorOpenId 点击者 open_id（老板限定校验用，拍板④）
   */
  function onCardAction(chatId: string, op: string, operatorOpenId?: string): boolean {
    const body = op.slice(APPROVAL_OP_PREFIX.length); // <entryId>:<decision>
    const sep = body.indexOf(":");
    if (sep === -1) return false;
    const entryId = body.slice(0, sep);
    const decision = body.slice(sep + 1);
    const entry = pending.get(entryId);
    if (!entry || entry.chatId !== chatId) {
      deps.logger?.warn?.(`审批卡回调：entry 不存在或 chatId 不匹配 entryId=${entryId} chatId=${chatId}`);
      return false;
    }
    // 老板限定（拍板④）：非老板 → 拒绝 + 回执（fail-closed，群聊防他人代批）
    if (!isBoss(operatorOpenId)) {
      deps.logger?.warn?.(`审批卡被非老板点击拦截 openId=${operatorOpenId ?? "unknown"} tool=${entry.toolName} → rejected`);
      entry.settle("rejected");
      deps.sendText(chatId, "🔐 审批卡仅限老板本人操作，已拒绝该请求。");
      return true;
    }
    switch (decision) {
      case "allow-once":
        entry.settle("allowed-once");
        break;
      case "deny":
        entry.settle("rejected");
        break;
      case "session":
        memory.addSession(chatId, entry.toolName);
        entry.settle("allowed-once");
        break;
      case "always":
        memory.addAlways(chatId, entry.toolName);
        entry.settle("allowed-once");
        break;
      default:
        deps.logger?.warn?.(`审批卡回调：未知决策 decision=${decision} entryId=${entryId}`);
        return false;
    }
    deps.logger?.info?.(`审批卡决策 chat=${chatId} tool=${entry.toolName} decision=${decision}`);
    return true;
  }

  return { answer, onCardAction, chatIdFromAgentId };
}

export type ApprovalBridge = ReturnType<typeof createApprovalBridge>;

// fs imports（放底部避免干扰类型导入可读性）
import { readFileSync, writeFileSync } from "node:fs";
