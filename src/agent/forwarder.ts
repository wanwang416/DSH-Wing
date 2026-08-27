/**
 * session 事件转发：DSH 原始事件 → 归一化对象 → 上层体验处理
 *
 * ★M3 任务 3 扩展（对齐成熟桥接 + Web UI trajectory）：
 * - assistant/chunk：区分 text-delta（回答流式）与 reasoning-delta（思考面板）
 * - tool/call：带 callId + input（参数摘要，解析 arguments JSON）
 * - tool/result：用 callId 反查工具名（message.content[0].type 只是兜底）
 * - user/message：source.kind !== "user" 视为上下文注入（Web UI 的 context 记录）
 */

export type SessionEventOut =
  | { type: "turn/start" }
  /** text-delta → 回答 main_text 流式 */
  | { type: "assistant/chunk"; text: string }
  /** reasoning-delta → 思考面板累积 */
  | { type: "assistant/thinking"; text: string }
  | { type: "assistant/message"; text: string }
  | { type: "turn/end"; reason: string }
  | { type: "tool/call"; name: string; input?: string; callId: string }
  | { type: "tool/result"; name?: string; callId?: string; error?: unknown }
  /** 上下文注入（user/message 且 source.kind !== "user"） */
  | { type: "user/message"; kind: "context"; text?: string };

function textOf(blocks: any[] | undefined): string {
  return (blocks ?? [])
    .filter((b) => b?.type === "text" && b.text !== undefined)
    .map((b) => b.text)
    .join("");
}

/** 原始 session 事件 → 归一化对象；不支持的返回 undefined */
export function toSessionEventOut(ev: any): SessionEventOut | undefined {
  switch (ev?.type) {
    case "turn/start":
      return { type: "turn/start" };
    case "assistant/chunk": {
      const c = ev.data?.chunk;
      if (c?.type === "text-delta") return { type: "assistant/chunk", text: c.text };
      // ★M3：reasoning-delta（思考流式），M2 遗漏
      if (c?.type === "reasoning-delta") return { type: "assistant/thinking", text: c.text ?? "" };
      return undefined;
    }
    case "assistant/message":
      return { type: "assistant/message", text: textOf(ev.data?.message?.content) };
    case "turn/end":
      return { type: "turn/end", reason: ev.data?.reason?.kind };
    case "tool/call": {
      const name = ev.data?.name ?? "?";
      // ★M3：解析 arguments JSON 为参数摘要（原始字符串可能很长）
      let input: string | undefined;
      const raw = ev.data?.arguments;
      if (typeof raw === "string" && raw.trim()) {
        input = raw;
      }
      return { type: "tool/call", name, input, callId: ev.data?.callId ?? "" };
    }
    case "tool/result": {
      // ★M3：name 由 callId 反查（onSessionEvent 内维护）；此处保留兜底
      const src = ev.data?.message?.source;
      const first = ev.data?.message?.content?.[0];
      return {
        type: "tool/result",
        callId: src?.callId,
        name: typeof first?.type === "string" ? first.type : undefined,
        error: ev.data?.error ?? (first?.isError === true ? "tool error" : undefined),
      };
    }
    case "user/message": {
      // ★M3：source.kind === "user" 是用户消息（飞书侧直接 handleInbound，不重复转发）
      //      source.kind !== "user" → 上下文注入（Web UI trajectory 的 context 记录）
      const sourceKind = ev.data?.source?.kind;
      if (sourceKind === undefined || sourceKind === "user") return undefined;
      return { type: "user/message", kind: "context", text: textOf(ev.data?.content) };
    }
    default:
      return undefined;
  }
}

export interface ForwarderDeps {
  onTurnStart(chatId: string): void;
  onChunk(chatId: string, text: string): void;
  onThinking(chatId: string, text: string): void;
  onAssistantMessage(chatId: string, text: string): void;
  onTurnEnd(chatId: string, reason: string): void;
  onToolCall(chatId: string, name: string, input?: string): void;
  onToolResult(chatId: string, name: string, error: unknown): void;
  onContext(chatId: string, text?: string): void;
}

export function createForwarder(deps: ForwarderDeps) {
  // ★M3：callId → 工具名 映射（tool/result 反查用；turn/end 时清空）
  const callNames = new Map<string, string>();

  return {
    onSessionEvent(chatId: string, event: SessionEventOut): void {
      switch (event.type) {
        case "turn/start":
          callNames.clear();
          deps.onTurnStart(chatId);
          break;
        case "assistant/chunk":
          deps.onChunk(chatId, event.text);
          break;
        case "assistant/thinking":
          deps.onThinking(chatId, event.text);
          break;
        case "assistant/message":
          deps.onAssistantMessage(chatId, event.text);
          break;
        case "turn/end":
          callNames.clear();
          deps.onTurnEnd(chatId, event.reason);
          break;
        case "tool/call":
          callNames.set(event.callId, event.name);
          deps.onToolCall(chatId, event.name, event.input);
          break;
        case "tool/result": {
          // 优先 callId 反查；查不到用事件自带 name 兜底
          const name = (event.callId ? callNames.get(event.callId) : undefined) ?? event.name ?? "?";
          deps.onToolResult(chatId, name, event.error);
          break;
        }
        case "user/message":
          deps.onContext(chatId, event.text);
          break;
      }
    },
  };
}
