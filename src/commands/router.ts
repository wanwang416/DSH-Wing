/**
 * P0-2 命令三级分流（★ 注册制，对齐基底成熟桥接命令路由）
 *
 * 分流规则：
 *   1. `/xxx` ∈ bridgeCommands（注册 Map）→ bridge（桥自处理，打 DONE 表情）
 *   2. `/xxx` ∈ DSH 注册命令（ctx.commands.find 命中）→ dsh（转发执行）
 *   3. 其余（未知 /xxx、普通消息）→ inject（原样注入 Agent，不吞命令）
 *
 * 优先级护栏（哈马注意事项 5）：命令路由在 index.ts 里先于四类分类执行，
 * 用户发 /stop 走命令分支，不被分类器误判成 COMMAND steer。
 */
import type { ParsedMessage } from "../inbound/parser.js";
import type { BridgeCommandDef, DshCommandService } from "./types.js";

export type RouteDecision =
  | { kind: "bridge"; command: BridgeCommandDef; rawInput: string }
  | { kind: "dsh"; name: string; rawInput: string; line: string; agent: unknown }
  | { kind: "inject" };

export interface CommandRouterDeps {
  /** 桥命令注册表（注册制：P0-3 具体命令加这里） */
  bridgeCommands: Map<string, BridgeCommandDef>;
  /** DSH 命令服务封装 */
  dsh: DshCommandService;
  /** 取当前会话的 rawAgent（Tier2 需要真实 agent 对象；未建返回 undefined → 降级） */
  getAgent(chatId: string): { raw: unknown } | undefined;
}

/** 剥离开头 @ 提及（对齐基底成熟桥接实现） */
export function stripLeadingMentions(text: string): string {
  let cur = text.trim();
  while (true) {
    const next = cur.replace(/^(?:<at[^>]*>.*?<\/at>|@\S+)\s*/i, "").trim();
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function createCommandRouter(deps: CommandRouterDeps) {
  return {
    isCommand(text: string): boolean {
      const cleaned = stripLeadingMentions(text);
      return /^\//.test(cleaned);
    },
    async route(text: string, msg: ParsedMessage): Promise<RouteDecision> {
      const cleaned = stripLeadingMentions(text);
      if (cleaned === "" || !cleaned.startsWith("/")) return { kind: "inject" };

      const tokens = cleaned.split(/\s+/);
      const head = tokens[0] ?? "";
      const name = head.replace(/^\/+/, "").toLowerCase();
      if (!name) return { kind: "inject" }; // 纯 "/" 无命令名
      const rawInput = tokens.slice(1).join(" ");

      // Tier1：桥命令（注册制 Map）
      const bridge = deps.bridgeCommands.get(name);
      if (bridge) return { kind: "bridge", command: bridge, rawInput };

      // Tier2：DSH 注册命令（对齐基底成熟桥接命令路由懒解析 agent）
      try {
        const agentEntry = deps.getAgent(msg.chatId);
        const agent = agentEntry?.raw;
        if (agent && deps.dsh.find(agent, name)) {
          const line = rawInput.trim() ? `/${name} ${rawInput.trim()}` : `/${name}`;
          return { kind: "dsh", name, rawInput, line, agent };
        }
      } catch {
        // find 异常 → 不当 DSH 命令，落 Tier3
      }

      // Tier3：其余原样注入 agent（未知命令不吞，哈马注意事项 4）
      return { kind: "inject" };
    },
  };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
