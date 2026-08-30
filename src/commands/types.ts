/**
 * P0-2 命令系统类型定义（注册制，对齐基底成熟桥接命令路由三级分流）
 *
 * 基底机制：成熟桥接命令路由（三级分流 + stripLeadingMentions）
 * 改进：桥命令用注册制 Map（新增命令 = 加文件 + 注册，不改路由核心）。
 */
import type { ParsedMessage } from "../inbound/parser.js";
import type { SelectorItem } from "../interactive/selector.js";
import type { PresetOption } from "../agent/preset.js";

/** DSH 命令执行结果（对齐 @deepseek-ai/dsh-commands CommandResult） */
export type DshCommandResult =
  | { kind: "success"; text?: string }
  | { kind: "error"; text: string };

/**
 * 桥命令执行上下文（P0-3 具体命令按需取用 services，全部可选——单测可只给被测命令用到的）
 */
export interface BridgeCommandContext {
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
  /** P0-3 注入的运行时服务（index.ts 组装时提供闭包，延迟到各对象就绪后） */
  services?: BridgeCommandServices;
}

/** 桥命令可用服务（注册制命令需要什么就取什么，可选链安全） */
export interface BridgeCommandServices {
  /** 会话映射（/stop /new /status 用） */
  mapper?: {
    size(): number;
    keys(): string[];
    get(chatId: string): { status: string; cancel(cause: { kind: string }): void } | undefined;
    disposeAgentFor(chatId: string): Promise<void>;
  };
  /** 路由持久化（/new 用：移除旧路由账目 → 下次全新创建；/resume 用：查历史 sessionId） */
  routeStore?: {
    remove(sessionKey: string): void;
    get(key: string): { sessionId?: string; updatedAt?: number } | undefined;
  };
  /** 出站待发计数（/status 用） */
  outbox?: { pendingCount(): number };
  /** 入站 WAL 待消化计数（/status 用） */
  inboundWal?: { pendingCount(): number };
  /** 连接状态（/status 用，supervisor.state()） */
  connection?: { state(): string };
  /** 可变 runtime（/mode /permission /status /preset 用） */
  runtime?: {
    getPermissionMode(): string;
    /** 校验 + 设置；非法模式返回 false */
    setPermissionMode(mode: string): boolean;
    getAgentPreset(): string;
    /** 设置 agent 预设（P1-2 /preset 单选卡；切换后由命令层触发 rotateSession） */
    setAgentPreset(id: string): void;
  };
  /** 当前模型（/status 用，动态读 agentDefaultModel.currentSelection） */
  getModel?(): Promise<{ provider?: string; model?: string } | undefined>;
  /** /new 完整 rotate（index.ts 提供：resetRunNonce + resetGeneration + dispose + route remove） */
  rotateSession?(chatId: string): Promise<void>;
  /** 已注册桥命令清单（/help 用） */
  listCommands?(): Array<{ name: string; description: string }>;
  /** P1-2：发交互卡（单选卡回复；outbox card enqueue，runCommand 收尾统一走） */
  sendCard?(chatId: string, card: Record<string, unknown>): unknown;
  /** P1-2：preset 候选列表（真实 roster 或兜底 4 档，index.ts 启动时加载） */
  listPresets?(): Promise<PresetOption[]>;
  /** P1-2：模型候选（llm.listProviders + listModels，构建 /model 单选卡） */
  getModelOptions?(): Promise<SelectorItem[]>;
  /** P1-2：per-chat 模型 override（/model 命令 + 单选卡回调共用同一 registry） */
  modelOverride?: {
    has(chatId: string): boolean;
    /** 设 override（persist + mutate live 对象，下条回复生效——拍板③） */
    set(chatId: string, sel: { provider: string; model: string }): void;
    clear(chatId: string): void;
  };
  /** P1-3：显式恢复上次会话（/resume；有 route → 触发 resumeAgent，无 → 提示） */
  resumeSession?(chatId: string): Promise<{ resumed: boolean; sessionId?: string }>;
  /** P1-3：工作区显示/切换（/workspace） */
  workspace?: {
    get(): string;
    /** 校验路径存在 + 设置为新工作区；成功返回 true */
    set(path: string): boolean;
  };
  /** P1-3：手动注入消息（/steer；running→steer，idle→followup；无 agent → no-agent） */
  steer?(chatId: string, text: string): Promise<"steered" | "queued" | "no-agent">;
  /** M4.2 /doctor 诊断包：生成诊断 ZIP */
  doctor?: {
    /** 生成诊断包；返回 ZIP 路径与大小 */
    generate(chatId: string): Promise<{ zipPath: string; size: number }>;
  };
  /** M4.2 /setup 扫码建应用：启动后台注册流程并等待二维码就绪 */
  setup?: {
    /**
     * 启动扫码创建应用流程（后台运行，非阻塞）。
     * 返回授权链接；30s 内未就绪返回 undefined。
     * 后台扫码完成后自动写凭据 + 重启 bridge + 发完成通知（由 index.ts 组装闭包实现）。
     */
    start(chatId: string): Promise<{ url: string; expireIn: number } | undefined>;
  };
}

/** 桥命令定义（注册制：新命令 = 定义此对象 + 注册进 bridgeCommands Map） */
export interface BridgeCommandDef {
  /** 无斜杠小写命令名 */
  name: string;
  /** 人类可读摘要（/help 发现用，全中文） */
  description: string;
  /** 执行体；返回 undefined 表示无回复 */
  run(
    deps: BridgeCommandContext,
    rawInput: string,
    msg: ParsedMessage,
  ): Promise<{ text?: string; card?: Record<string, unknown> } | undefined>;
}

/** DSH 命令服务薄封装（真实 API：@deepseek-ai/dsh-commands CommandRuntime） */
export interface DshCommandService {
  /** 是否已注册（agent-scoped，对齐 CommandRuntime.find） */
  find(agent: unknown, name: string): boolean;
  /** 执行（对齐 CommandRuntime.execute(agent, line, images, signal)，images 传空数组） */
  execute(agent: unknown, line: string): Promise<DshCommandResult | undefined>;
}
