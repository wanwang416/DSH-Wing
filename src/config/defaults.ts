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
