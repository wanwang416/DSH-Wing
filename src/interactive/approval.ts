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
import { chatIdFromSessionId } from "../session/mapper.js";

export interface ApprovalMemoryDeps {
  file: string;
  logger?: { info?(m: string): void; warn?(m: string): void };
}

/** 审批记忆（Session 内存 / Always 落盘 JSON）★ G6（阶段5b）：键绑定批准者身份，只对同一批准者自动放行 */
export function createApprovalMemory(deps: ApprovalMemoryDeps) {
  const log = deps.logger;
  // Session 记忆（进程内存）：键 = chatId:toolName:operatorId —— 只对同一批准者生效
  const session = new Set<string>();
  // Always 记忆（落盘）：{ "chatId:toolName": [operatorId...] } —— 记录"该工具由谁永久放行"
  let always = new Map<string, Set<string>>();
  try {
    const raw = readFileSync(deps.file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      // 兼容两种历史格式：string[]（旧，无身份）→ 忽略其自动放行效力（fail-closed：
      // 旧格式无法证明是谁批准的，不该给任何人免审批特权，重新走一次审批即可重建）
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        always.set(k, new Set(v as string[]));
      }
    }
  } catch {
    always = new Map();
  }
  // ★ M14（阶段5b-2）：tmp + rename 原子写（照抄 dedup.ts / permission-overrides.ts 同一套写法）——
  //   写一半被杀/磁盘满 → 原文件不被破坏，旧记忆不丢；失败 warn 留痕（不静默）
  const persist = (): void => {
    const tmp = `${deps.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries([...always].map(([k, v]) => [k, [...v]])), null, 2), { mode: 0o600 });
      renameSync(tmp, deps.file);
    } catch (err) {
      log?.warn?.(`审批记忆落盘失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
      try {
        if (existsSync(tmp)) rmSync(tmp);
      } catch {
        // 清理失败不致命
      }
    }
  };
  const key = (chatId: string, toolName: string, operatorId?: string): string =>
    operatorId ? `${chatId}:${toolName}:${operatorId}` : `${chatId}:${toolName}:__nobody__`;
  return {
    /** ★ G6：记忆命中必须带请求发起者身份——只对当初批准的那个人自动放行 */
    shouldAutoAllow(chatId: string, toolName: string, operatorId?: string): boolean {
      const k = key(chatId, toolName, operatorId);
      return session.has(k) || (always.get(`${chatId}:${toolName}`)?.has(operatorId ?? "__nobody__") ?? false);
    },
    addSession(chatId: string, toolName: string, operatorId?: string): void {
      session.add(key(chatId, toolName, operatorId));
    },
    addAlways(chatId: string, toolName: string, operatorId?: string): void {
      const k = `${chatId}:${toolName}`;
      const set = always.get(k) ?? new Set<string>();
      set.add(operatorId ?? "__nobody__");
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
  /**
   * ★ G6-B（阶段5b-2，ALAN 拍板 B 方案）：当前 turn 发起者快照（chatId → senderOpenId）。
   *   群聊 Always 记忆只对当初点它的那个人生效：老板在群里点过 Always 后，老板自己触发免问，他人照样审批。
   *   拿不到快照 → undefined → 记忆不自动放行（fail-closed，安全侧退化）。
   */
  initiatorOf?(chatId: string): string | undefined;
  /** 审批超时 ms（默认 turnTimeoutMs 同源；超时 → cancelled） */
  timeoutMs?: number;
  logger?: { info?(m: string): void; warn?(m: string): void };
  /** Always 记忆落盘文件 */
  memoryFile: string;
  /**
   * ★ 2026-10-01 企微线路：判定该 chat 走哪条通道。
   *   "wecom" → 企微没有模板卡片 API，改发「编号文本审批」（回复 1-4 决策）
   *   其余（含 undefined）→ 保持原飞书审批卡行为，一字不变
   */
  platformOf?(chatId: string): "feishu" | "wecom" | undefined;
  /** ★ 企微老板 userid（企微身份与飞书 open_id 不同源；配置后文本审批做精确限定） */
  wecomBossUserId?: string;
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

/** 从 agent.id 反推 chatId（本插件 sessionId = <平台>:<chatId>:<runNonce>:<gen>）；非本插件 → undefined */
export function chatIdFromAgentId(agentId: string): string | undefined {
  // ★ 2026-10-01：认 feishu:/wecom: 两种前缀（此前只认 feishu: → 企微会话审批桥认不出会话，
  //   直接 next() 丢给 GUI，企微侧永远沉默）
  return chatIdFromSessionId(agentId);
}

/**
 * ★ 2026-10-01 企微线路：审批文本（对齐 buildApprovalCard 的四选项与顺序）。
 * 企微智能机器人没有模板卡片 API，只能用文本 + 编号回复。
 */
export function buildApprovalText(opts: { entryId: string; toolName: string; reason?: string }): string {
  return [
    `🔓 操作审批`,
    ``,
    `⚠️ ${opts.toolName} 请求执行`,
    opts.reason ?? "（无说明）",
    ``,
    `（本次审批编号：${opts.entryId}）`,
    `请回复数字决定：`,
    `1 = ✅ 允许一次（仅本次）`,
    `2 = 🕐 本会话允许（同工具不再问）`,
    `3 = ♾️ 永久允许（写盘记忆）`,
    `4 = ❌ 拒绝`,
    ``,
    `多条审批并存时，请带编号回复（例：编号 ${opts.entryId} 1）`,
    `（回复其他内容视为未决，超时自动失效）`,
  ].join("\n");
}

/** ★ 2026-10-01 企微线路：审批收口文本（对齐 buildApprovalSettledCard） */
export function buildApprovalSettledText(opts: { toolName: string; outcome: ApprovalOutcome }): string {
  const table: Record<ApprovalOutcome, string> = {
    "allowed-once": `✅ 已允许 ${opts.toolName} 本次执行。`,
    rejected: `❌ 已拒绝 ${opts.toolName} 执行。`,
    cancelled: `⏰ ${opts.toolName} 的审批请求已失效（超时或中断）。`,
    unavailable: `⚠️ 审批提示发送失败，${opts.toolName} 未放行（fail-closed）。`,
  };
  return table[opts.outcome];
}

/** ★ 2026-10-01：企微文本审批的决策解析（1-4 / 文字别名）；无法识别 → undefined */
export function parseApprovalTextAnswer(text: string): "allow-once" | "session" | "always" | "deny" | undefined {
  const t = text.trim().toLowerCase();
  if (t === "1" || t === "允许" || t === "允许一次" || t === "同意" || t === "allow" || t === "yes" || t === "y") return "allow-once";
  if (t === "2" || t === "本会话" || t === "会话" || t === "session") return "session";
  if (t === "3" || t === "永久" || t === "永久允许" || t === "always") return "always";
  if (t === "4" || t === "拒绝" || t === "deny" || t === "no" || t === "n") return "deny";
  return undefined;
}

export function createApprovalBridge(deps: ApprovalBridgeDeps) {
  const pending = new Map<string, PendingEntry>();
  const memory = createApprovalMemory({ file: deps.memoryFile, logger: deps.logger });
  let entryCounter = 0;

  const isBoss = (openId: string | undefined): boolean => {
    // ★ M15（阶段5b）：fail-closed——bossOpenId 未配置 → 一律拒绝（不再单用户宽松），warn 每次都打
    if (!deps.bossOpenId) {
      deps.logger?.warn?.("未配置老板身份（bossOpenId），审批不可用——请在 config 配置 WING_LARK_APP 老板 open_id 后重启。（每次拒绝都留痕）");
      return false;
    }
    return openId === deps.bossOpenId;
  };

  /** approval/request answerer（waterfall）：返回 outcome 认领，非本插件 agent → next() */
  async function answer(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatId = req.agent?.id ? chatIdFromAgentId(req.agent.id) : undefined;
    if (!chatId) return next(); // 非本插件 agent，让其他 answerer

    // 记忆命中（Always/Session）→ 直接放行，不发卡
    // ★ G6-B（阶段5b-2，ALAN 拍板）：发起者身份 = initiatorOf 快照（turn 开始时记录的发送者）；
    //   快照缺失 → p2p 回退用 chatId（≡归属者，parser 保证），群聊拿不到 → undefined → 不自动放行（fail-closed）。
    //   旧口径（5b-1）= 群聊用 chatId 顶替 → 永不命中；B 口径 = 老板在群里点 Always 后老板免问。
    const initiator = deps.initiatorOf?.(chatId) ?? chatId;
    if (memory.shouldAutoAllow(chatId, req.toolName, initiator)) {
      deps.logger?.info?.(`审批记忆命中（always）chat=${chatId} tool=${req.toolName} initiator=${initiator} → allowed-once`);
      return "allowed-once";
    }

    // 无记忆 → 发审批卡，等用户决策（超时/abort → cancelled，fail-closed）
    const textMode = deps.platformOf?.(chatId) === "wecom";
    return await new Promise<ApprovalOutcome>((resolve) => {
      const entryId = `a${++entryCounter}_${Date.now()}`;
      const toolName = req.toolName;
      let settled = false;
      // ★ Bug3b：记录已发卡 message_id，供 settle 决策后 updateCard 收口换状态卡
      let sentCardMessageId: string | undefined;
      // ★ M16（阶段5b）：发卡 promise 句柄——settle 若先于发卡完成触发，等待其 resolve 后补刷终态
      let sendCardDone: Promise<void> = Promise.resolve();
      // timer 先声明（settle 闭包引用；TDZ 安全——settle 只在事件回调/超时/abort 时被调，彼时已赋值）
      let timer: ReturnType<typeof setTimeout> | undefined;
      // ★ M42（阶段5b-2）：持 abort 监听引用，settle 时主动摘除——abort 一直不来时监听随 signal
      //   常驻内存（每个 pending 一份），settle 后不再需要
      const onAbort = (): void => settle("cancelled");
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (req.signal) req.signal.removeEventListener("abort", onAbort); // ★ M42
        pending.delete(entryId);
        // ★ Bug3b：收口——把原四按钮卡替换成状态卡（✅已允许/❌已拒绝/⏰已失效），不再停留可操作界面
        // ★ M16（阶段5b）：settle 先等"发卡完成"，再按已回填的 message_id 刷终态——
        //   覆盖三类竞态：① 卡还没发完用户就决策/超时 ② 发卡完成但秒点 ③ 发卡失败（unavailable，
        //   无 messageId 可刷，走 textMode 文本收口）。任何收口路径最终都把卡刷成终态。
        void sendCardDone.then(() => {
          if (sentCardMessageId) {
            return deps
              .updateCard(sentCardMessageId, JSON.stringify(buildApprovalSettledCard({ toolName, outcome })))
              .catch(() => void 0);
          }
          if (textMode) {
            // ★ 2026-10-01 企微线路：无卡片可收口 → 补一条文本结果
            return Promise.resolve(deps.sendText(chatId, buildApprovalSettledText({ toolName, outcome }))).catch(() => void 0);
          }
          return undefined;
        });
        resolve(outcome);
      };
      const entry: PendingEntry = { chatId, toolName, settle };
      pending.set(entryId, entry);

      // timer 与 abort listener 同步挂好（不依赖 sendCard resolve：
      //   ① abort 即时性——signal abort 在发送完成前也能取消，fail-closed；
      //   ② 超时窗口含发送过程，维持原「发卡后立即计时」语义）
      timer = setTimeout(() => settle("cancelled"), deps.timeoutMs ?? 300_000);
      timer.unref?.();
      req.signal?.addEventListener("abort", onAbort, { once: true }); // ★ M42：监听持引用，settle 时摘除
      try {
        if (textMode) {
          // ★ 2026-10-01 企微线路：无模板卡片 API → 发编号文本审批（回复 1-4 决策，见 onTextInbound）
          Promise.resolve(deps.sendText(chatId, buildApprovalText({ entryId, toolName, reason: req.reason })))
            .then(() => {
              deps.logger?.info?.(`审批已发送（企微文本模式）chat=${chatId} tool=${toolName} entry=${entryId}`);
            })
            .catch((err) => {
              deps.logger?.warn?.(
                `企微审批文本发送失败 chat=${chatId} tool=${toolName}: ${err instanceof Error ? err.message : String(err)}`,
              );
              settle("unavailable");
            });
        } else {
          // Bug3b：审批卡直发 sender.sendCard → resolve 后捕获 message_id，供 settle 决策后收口换状态卡
          // ★ M16：记录发卡完成 promise（settle 早于发卡完成时，等它 resolve 再补刷终态）
          sendCardDone = deps
            .sendCard(chatId, buildApprovalCard({ entryId, toolName, reason: req.reason, bossOpenId: deps.bossOpenId }))
            .then((res) => {
              sentCardMessageId = deps.messageIdOf(res);
            })
            .catch((err) => {
              // 发卡失败 → fail-closed（settle 幂等：超时/abort 先触发则不覆盖）
              deps.logger?.warn?.(`审批卡发送失败 chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`);
              settle("unavailable");
            });
        }
      } catch (err) {
        // 防御：同步 throw（如 mock 同步抛）→ fail-closed
        deps.logger?.warn?.(`审批卡发送同步异常 chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`);
        settle("unavailable");
      }
    });
  }

  /** 审批卡回调（event-handler op 路由：approval:<entryId>:<decision>）*/
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
    // 老板限定（拍板④ + ★M15 阶段5b fail-closed）：非老板或未配置 → 拒绝 + 人话回执（每次留痕）
    if (!isBoss(operatorOpenId)) {
      const reason = !deps.bossOpenId
        ? "❓ 未配置老板身份（bossOpenId），审批不可用——请在 config 配置 WING_LARK_APP 老板 open_id 后重启。本次已拒绝（fail-closed）。"
        : "🔐 审批卡仅限老板本人操作，已拒绝该请求。";
      deps.logger?.warn?.(`审批卡拦截 openId=${operatorOpenId ?? "unknown"} tool=${entry.toolName} configured=${Boolean(deps.bossOpenId)} → rejected`);
      entry.settle("rejected");
      deps.sendText(chatId, reason);
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
        memory.addSession(chatId, entry.toolName, operatorOpenId); // ★ G6：绑定批准者
        entry.settle("allowed-once");
        break;
      case "always":
        memory.addAlways(chatId, entry.toolName, operatorOpenId); // ★ G6：绑定批准者
        entry.settle("allowed-once");
        break;
      default:
        deps.logger?.warn?.(`审批卡回调：未知决策 decision=${decision} entryId=${entryId}`);
        return false;
    }
    deps.logger?.info?.(`审批卡决策 chat=${chatId} tool=${entry.toolName} decision=${decision}`);
    return true;
  }

  /**
   * ★ 2026-10-01 企微线路：文本审批回执（企微无卡片 API，用编号回复决策）。
   * ★ M5（阶段5b-2）：群聊文本审批命中修复——旧实现硬拒群聊（chatType !== "p2p" 直接 return），
   *   群里发的提示永远无法被回复命中。现改为：群聊也消费，但**身份校验照旧 fail-closed**
   *   （operatorId 必须 === wecomBossUserId，非老板/未配置 → 拒绝），防群成员代批不放松。
   * ★ M6（阶段5b-2）：不再取"第一个 pending"——优先按回复中的编号（entryId）精确匹配；
   *   带编号但匹配不到 → 不结算任何审批 + 提示（fail-closed 不猜）；不带编号且该 chat 仅一条
   *   pending → 兼容旧行为；不带编号且多条并存 → 提示带编号重发，不猜。
   * @returns true=已消费该消息（index.ts 不再当普通消息注入 agent）
   */
  function onTextInbound(chatId: string, text: string, ctx?: { operatorId?: string; chatType?: "p2p" | "group" }): boolean {
    if (deps.platformOf?.(chatId) !== "wecom") return false; // 飞书走卡片按钮，不抢文本
    // ★ M6：解析"编号 <entryId> <决策>"（兼容"编号：xxx 1"/纯决策两种写法）
    const withId = /编号[:：\s]*([A-Za-z0-9_]+)\s*(.*)/.exec(text.trim());
    const decisionText = withId ? (withId[2]?.trim() || text.trim()) : text.trim();
    const decision = parseApprovalTextAnswer(decisionText);

    // 定位目标审批：优先编号精确匹配；否则（无编号）限定同 chat 的 pending
    let entry: PendingEntry | undefined;
    let entryId: string | undefined;
    if (withId) {
      const wanted = withId[1]!;
      for (const [id, e] of pending) {
        if (id === wanted) {
          // 编号是全局唯一的：连 chatId 都对不上 = 拿别的会话的审批编号来冒充 → 不结算（不猜）
          if (e.chatId !== chatId) {
            deps.logger?.warn?.(`企微文本审批：编号属于其他会话，拒绝处理 entry=${wanted} chat=${chatId}`);
            void Promise.resolve(deps.sendText(chatId, `⚠️ 编号不匹配：该编号不属于本会话的审批，请核对本会话审批提示里的编号。`)).catch(() => void 0);
            return true;
          }
          entry = e;
          entryId = id;
          break;
        }
      }
      if (!entry) {
        // 带编号但找不到 → 不猜，不结算任何 pending（fail-closed）
        deps.logger?.warn?.(`企微文本审批：编号不存在（可能已收口/超时），不结算任何审批 entry=${wanted} chat=${chatId}`);
        void Promise.resolve(deps.sendText(chatId, `⚠️ 编号不匹配：未找到该编号的待审批请求（可能已收口或超时）。`)).catch(() => void 0);
        return true;
      }
    } else {
      const mine = [...pending.entries()].filter(([, e]) => e.chatId === chatId);
      if (mine.length === 1) {
        entryId = mine[0]![0];
        entry = mine[0]![1];
      } else if (mine.length > 1) {
        deps.logger?.warn?.(`企微文本审批：${mine.length} 条审批并存且回复未带编号，不猜——请带编号回复 chat=${chatId}`);
        void Promise.resolve(deps.sendText(chatId, `⚠️ 当前有 ${mine.length} 条待审批，为避免串台请带编号回复（例：编号 ${mine[0]![0]} 1）。`)).catch(() => void 0);
        return true;
      } else {
        return false; // 该 chat 无 pending，与审批无关
      }
    }

    // ★ M15/M5（阶段5b-2 保持）：fail-closed——wecomBossUserId 未配置或 operatorId 取不到 → 一律拒绝。
    //   群聊场景同样走这里（M5 修复后群聊也能到这行），身份不匹配的群成员回复会被拒绝并留痕。
    //   ★ 顺序（阶段5b-2 修正）：身份校验在"决策识别"之后——群里非老板的**非决策闲聊**不得把
    //     老板的审批打成 rejected（恶意否决也是干预）；只有"明确做出决策"且身份不对才拒绝。
    if (decision === undefined) {
      deps.logger?.info?.(`企微文本审批：未识别回复（保持待批）chat=${chatId} text="${text.slice(0, 20)}"`);
      void Promise.resolve(deps.sendText(chatId, "⚠️ 有待审批请求，请回复 1-4 决定（多条并存请带编号；其他内容已照常转给助手）。")).catch(() => void 0);
      return false;
    }
    if (!deps.wecomBossUserId || !ctx?.operatorId || ctx.operatorId !== deps.wecomBossUserId) {
      const reason = !deps.wecomBossUserId
        ? "未配置老板身份（wecomBossUserId），企微审批不可用——请在 config 配置后重启。"
        : !ctx?.operatorId
          ? "无法确认操作者身份，企微审批仅限老板本人。"
          : undefined;
      if (reason) {
        deps.logger?.warn?.(`企微文本审批拦截（fail-closed）：${reason} operator=${ctx?.operatorId ?? "unknown"} tool=${entry.toolName} chatType=${ctx?.chatType ?? "unknown"}`);
      } else {
        deps.logger?.warn?.(`企微文本审批被非老板拦截 operator=${ctx?.operatorId} tool=${entry.toolName} chatType=${ctx?.chatType ?? "unknown"} → rejected`);
      }
      entry.settle("rejected");
      void Promise.resolve(deps.sendText(chatId, reason ?? "🔐 审批仅限老板本人操作，已拒绝该请求。")).catch(() => void 0);
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
        memory.addSession(chatId, entry.toolName, ctx.operatorId); // ★ G6：绑定批准者（老板，M15 已校验）
        entry.settle("allowed-once");
        break;
      case "always":
        memory.addAlways(chatId, entry.toolName, ctx.operatorId); // ★ G6：绑定批准者
        entry.settle("allowed-once");
        break;
    }
    void entryId; // 编号匹配已在上方完成，此处仅结算
    deps.logger?.info?.(`企微文本审批决策 chat=${chatId} tool=${entry.toolName} decision=${decision} entry=${entryId}`);
    return true;
  }

  return { answer, onCardAction, onTextInbound, chatIdFromAgentId };
}

export type ApprovalBridge = ReturnType<typeof createApprovalBridge>;

// fs imports（放底部避免干扰类型导入可读性）
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
