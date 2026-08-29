/**
 * dsh-wing 默认配置（M1）
 *
 * ★ 与 成熟桥接实现 反着来（阿深体感修正）：
 *   - streaming.enabled 默认 true（过程透明，ALAN 第一需求；成熟桥接实现 默认 false）
 *   - permissionMode 默认 workspace-write（权限保守；成熟桥接实现 默认 danger-full-access）
 */

export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";
export type GroupPolicy = "open" | "mention" | "keywords" | "reply";

export interface StreamingConfig {
  /** 是否默认开启流式转发（assistant/chunk → 飞书） */
  enabled: boolean;
  /** 流式刷新间隔 ms：chunk 累积这么久发一次更新 */
  flushMs: number;
}

export interface ReactionsConfig {
  enabled: boolean;
  /** 收到消息时的随机表情池（飞书 emoji_type 有效值） */
  pool: string[];
  /** 完成表情 */
  done: string;
  /** 失败表情 */
  failed: string;
}

export interface WingConfig {
  /** ctx.credentials 凭据引用名 */
  credentialRef: string;
  streaming: StreamingConfig;
  permissionMode: PermissionMode;
  /** 群聊触发策略（M1 只影响 chatMode 判定，M2 完整实现） */
  groupPolicy: GroupPolicy;
  reactions: ReactionsConfig;
  /** 轮次超时（ms），超时 dispose agent 解锁 */
  turnTimeoutMs: number;
  /** 会话工作区根目录（默认 process.cwd()） */
  workspaceRoot?: string;
  /** agent preset */
  agentPreset: string;
  /**
   * 任务中断四类分类开关（P0-1 ★ ALAN 灵魂设计）。
   * 默认开启，可用环境变量 `DSH_WING_INTERRUPT_CLASSIFIER=0` 关闭（回退旧 steer/停止词逻辑）。
   * 命名走行为描述（interruptClassifierEnabled），不用版本号（interruptV4）——豆包拍板。
   */
  interruptClassifierEnabled: boolean;
  /**
   * steer 排障日志路径（C1 收尾项：原写死固定路径且每轮都写）。
   * 默认 undefined = 关闭（零开销）；排障时在 config.json 配路径临时开启。
   */
  steerDiagLogPath?: string;
  /**
   * 老板 open_id（P1-1 审批卡限定：ALAN 拍板④，防群聊他人代替老板批准危险操作）。
   * 未配置 → 审批卡不拦截任何人（单用户宽松 + 日志 warn 提示风险）。
   */
  bossOpenId?: string;
}

export const DEFAULT_CONFIG: WingConfig = {
  credentialRef: "WING_LARK_APP",
  streaming: {
    enabled: true,
    flushMs: 500,
  },
  permissionMode: "workspace-write",
  groupPolicy: "mention",
  reactions: {
    enabled: true,
    pool: ["THUMBSUP", "OK", "HEART", "LAUGH", "SMILE", "WOW", "CLAP", "Fire"],
    done: "DONE",
    failed: "CrossMark",
  },
  turnTimeoutMs: 600_000,
  agentPreset: "code",
  // 环境变量显式置 "0" 才关闭；config.json 可覆盖（getConfig 的 ...raw 天然优先）
  interruptClassifierEnabled: process.env.DSH_WING_INTERRUPT_CLASSIFIER !== "0",
};

/** 合并 rawConfig 与默认值（嵌套对象深合并） */
export function getConfig(ctx: unknown, rawConfig: unknown): WingConfig {
  void ctx;
  const raw = (rawConfig ?? {}) as Partial<WingConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    streaming: { ...DEFAULT_CONFIG.streaming, ...(raw.streaming ?? {}) },
    reactions: { ...DEFAULT_CONFIG.reactions, ...(raw.reactions ?? {}) },
  };
}
