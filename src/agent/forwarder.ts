/**
 * session 事件转发：6 种事件 → 归一化对象 → 上层体验处理
 *
 * 参考成熟桥接实现。
 */

export type SessionEventOut =
  | { type: "turn/start" }
  | { type: "assistant/chunk"; text: string }
  | { type: "assistant/message"; text: string }
  | { type: "turn/end"; reason: string }
  | { type: "tool/call"; name: string }
  | { type: "tool/result"; name: string; error?: unknown }
  | { type: "ask-user-question"; questions: any[] };

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
      return undefined;
    }
    case "assistant/message":
      return { type: "assistant/message", text: textOf(ev.data?.message?.content) };
    case "turn/end":
      return { type: "turn/end", reason: ev.data?.reason?.kind };
    case "tool/call":
      return { type: "tool/call", name: ev.data?.name };
    case "tool/result":
      return {
        type: "tool/result",
        name: ev.data?.message?.content?.[0]?.type ?? "?",
        error: ev.data?.error,
      };
    case "ask-user-question":
      // 提问工具 → 透传 questions
      return {
        type: "ask-user-question",
        questions: ev.data?.questions,
      };
    default:
      return undefined;
  }
}

export interface ForwarderDeps {
  onTurnStart(chatId: string): void;
  onChunk(chatId: string, text: string): void;
  onAssistantMessage(chatId: string, text: string): void;
  onTurnEnd(chatId: string, reason: string): void;
  onToolCall(chatId: string, name: string): void;
  onToolResult(chatId: string, name: string, error: unknown): void;
  onAskUserQuestion(chatId: string, questions: any[]): void;
}

export function createForwarder(deps: ForwarderDeps) {
  return {
    onSessionEvent(chatId: string, event: SessionEventOut): void {
      switch (event.type) {
        case "turn/start":
          deps.onTurnStart(chatId);
          break;
        case "assistant/chunk":
          deps.onChunk(chatId, event.text);
          break;
        case "assistant/message":
          deps.onAssistantMessage(chatId, event.text);
          break;
        case "turn/end":
          deps.onTurnEnd(chatId, event.reason);
          break;
        case "tool/call":
          deps.onToolCall(chatId, event.name);
          break;
        case "tool/result":
          deps.onToolResult(chatId, event.name, event.error);
          break;
        case "ask-user-question":
          deps.onAskUserQuestion(chatId, event.questions);
          break;
      }
    },
  };
}
