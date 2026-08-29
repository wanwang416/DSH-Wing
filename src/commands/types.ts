/**
 * P0-2 命令系统类型定义（注册制，对齐基底  成熟桥接 命令路由三级分流）
 *
 * 基底机制： 成熟桥接src/application/命令路由.ts（三级分流 + stripLeadingMentions）
 * 改进：桥命令用注册制 Map（新增命令 = 加文件 + 注册，不改路由核心）。
 */
import type { ParsedMessage } from "../inbound/parser.js";

/** DSH 命令执行结果（对齐 @deepseek-ai/dsh-commands CommandResult） */
export type DshCommandResult =
  | { kind: "success"; text?: string }
  | { kind: "error"; text: string };

/** 桥命令执行上下文（P0-3 具体命令按需扩展） */
export interface BridgeCommandContext {
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}

/** 桥命令定义（注册制：新命令 = 定义此对象 + 注册进 bridgeCommands Map） */
export interface BridgeCommandDef {
  /** 无斜杠小写命令名 */
  name: string;
  /** 人类可读摘要（/help 发现用，全中文） */
  description: string;
  /** 执行体；返回 undefined 表示无回复文本 */
  run(
    deps: BridgeCommandContext,
    rawInput: string,
    msg: ParsedMessage,
  ): Promise<{ text?: string } | undefined>;
}

/** DSH 命令服务薄封装（真实 API：@deepseek-ai/dsh-commands CommandRuntime） */
export interface DshCommandService {
  /** 是否已注册（agent-scoped，对齐 CommandRuntime.find） */
  find(agent: unknown, name: string): boolean;
  /** 执行（对齐 CommandRuntime.execute(agent, line, images, signal)，images 传空数组） */
  execute(agent: unknown, line: string): Promise<DshCommandResult | undefined>;
}
