/**
 * Agent 调用层：创建/恢复 DSH session agent
 *
 * 参考前期调研结论 + 成熟桥接实现 适配层：
 * - ctx.agents.create({sessionId, meta:{cwd, agentPreset}, setup}) → {agent, dispose}
 * - ctx.agents.resume({resumeSessionId, setup}) → 重启恢复
 * - agent.ctx.on("session/event", ...) 订阅 6 种事件
 */

import { makeSessionId } from "../session/mapper.js";
import { toSessionEventOut, type SessionEventOut } from "./forwarder.js";
import { applyPermission } from "./permission.js";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { appendFileSync } from "node:fs";
import { join as pathJoin, basename } from "node:path";
import type { PermissionMode } from "../config/defaults.js";

export interface CreateAgentDeps {
  ctx: any;
  workspaceRoot?: string;
  agentPreset: string;
  /** ★ 权限模式（默认保守 workspace-write） */
  permissionMode: PermissionMode;
  /** 事件回调：chatId + 归一化 session 事件 */
  onSessionEvent(chatId: string, event: SessionEventOut): void;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
}

export interface WingAgentHandle {
  agentId: string;
  sessionId: string;
  /** 排队普通 turn（next-turn 边界） */
  followup(message: unknown): void;
  /** ★ 温和打断（next-step 边界消费，M0 Spike 7 核心发现） */
  steer(message: unknown): void;
  /** 停止当前 turn */
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void;
  readonly status: string;
  whenIdle?(): Promise<void>;
  dispose(): Promise<void>;
}

/** 创建 agent（sessionId = feishu:<chatId>:<random8>:0） */
/** workspace attach（铁律：session 必须归属工作区，否则 DSH 无法正确管理/恢复） */
async function attachWorkspace(ctx: any, cwd: string, sessionId: string, logger?: { warn?: (m: string) => void; info?: (m: string) => void }): Promise<void> {
  try {
    const workspaces = ctx.get?.("workspaceRegistry");
    if (workspaces?.create) {
      const entity = await workspaces.create(cwd, basename(cwd));
      if (entity?.attachSession) {
        await entity.attachSession(sessionId);
        logger?.info?.(`workspace attach: ${sessionId} -> ${cwd}`);
      } else {
        logger?.warn?.(`workspace attach skipped: entity 无 attachSession（${cwd}）`);
      }
    } else {
      logger?.warn?.("workspaceRegistry 不可用——session 将显示在未分组");
    }
  } catch (err) {
    logger?.warn?.(`workspace create/attach 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function createAgent(deps: CreateAgentDeps, chatId: string): Promise<WingAgentHandle> {
  const { ctx } = deps;
  const sessionId = makeSessionId(chatId);
  const cwd = deps.workspaceRoot ?? process.cwd();

  // 当前 GUI 模型选择（DSH agent 必须有 provider/model，否则 turn 失败）
  const admService = ctx.get?.("agentDefaultModel");
  const cur = admService?.currentSelection?.();
  const sel = cur?.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
  if (!sel) deps.logger?.warn?.("无模型选择——agent turn 可能失败");

  const setup = async (agentCtx: any): Promise<void> => {
    // 挂模型选择（agent 请求用 GUI 当前模型）
    if (sel) {
      try {
        installModelSelection(agentCtx, { current: sel, assembled: undefined });
      } catch (err) {
        deps.logger?.warn?.(`installModelSelection 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // M1：不注册 agent 级专属工具（M2 加 feishu_send_local_file）
  };

  let owned: any;
  try {
    owned = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: deps.agentPreset },
      ...(sel ? { agentOptions: sel } : {}),
      setup,
    });
  } catch (err) {
    // session id 冲突（已存在持久化日志）→ 改为 resume
    if (err instanceof Error && /already exists|already has a persisted log/i.test(err.message)) {
      owned = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(sel ? { agentOptions: sel } : {}),
        setup,
      });
    } else {
      throw err;
    }
  }
  if (!owned?.agent) throw new Error(`agents.create 未返回 agent（chatId=${chatId}）`);
  const agent = owned.agent;

  // ★ workspace attach（session 归属工作区，DSH 才能正确管理/恢复——ALAN 反馈 1/2）
  await attachWorkspace(ctx, cwd, sessionId, deps.logger);

  // ★ 权限应用（默认保守 workspace-write，M1 就做）
  applyPermission(ctx, agent, deps.permissionMode, deps.logger);

  // 事件订阅：session/event → 归一化 → 回调
  const disp = agent.ctx.on("session/event", (_session: unknown, ev: unknown) => {
    const out = toSessionEventOut(ev);
    if (out) {
      try {
        deps.onSessionEvent(chatId, out);
      } catch (err) {
        deps.logger?.warn?.(`onSessionEvent 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return {
    agentId: agent.id,
    sessionId,
    followup(message) {
      agent.followup(message);
    },
    steer(message) {
      agent.steer(message);
    },
    cancel(cause, options) {
      agent.cancel(cause, options);
    },
    get status() {
      return agent.status;
    },
    whenIdle() {
      return typeof agent.whenIdle === "function" ? agent.whenIdle() : Promise.resolve();
    },
    async dispose() {
      disp();
      await owned.dispose();
    },
  };
}

/** 恢复历史 session（routes.json 有映射、重启后） */
export async function resumeAgent(deps: CreateAgentDeps, sessionId: string): Promise<WingAgentHandle> {
  const { ctx } = deps;
  // 当前 GUI 模型选择
  const admService = ctx.get?.("agentDefaultModel");
  const cur = admService?.currentSelection?.();
  const sel = cur?.provider && cur.model ? { provider: cur.provider, model: cur.model } : undefined;
  const setup = async (agentCtx: any): Promise<void> => {
    if (sel) {
      try {
        installModelSelection(agentCtx, { current: sel, assembled: undefined });
      } catch (err) {
        deps.logger?.warn?.(`installModelSelection 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // M1 无专属工具
  };
  const owned = await ctx.agents.resume({
    resumeSessionId: sessionId,
    ...(sel ? { agentOptions: sel } : {}),
    setup,
  });
  if (!owned?.agent) throw new Error(`agents.resume 未返回 agent（sessionId=${sessionId}）`);
  const agent = owned.agent;

  // workspace attach（resume 的 session 同样归属工作区）
  await attachWorkspace(ctx, deps.workspaceRoot ?? process.cwd(), sessionId, deps.logger);

  // 权限应用（resume 的 agent 同样设置）
  applyPermission(ctx, agent, deps.permissionMode, deps.logger);

  const disp = agent.ctx.on("session/event", (_session: unknown, ev: unknown) => {
    const out = toSessionEventOut(ev);
    if (out) {
      try {
        // resume 的 session 需要 chatId——从 sessionId 反推：feishu:<chatId>:...
        const chatId = sessionId.slice("feishu:".length).split(":")[0] ?? sessionId;
        deps.onSessionEvent(chatId, out);
      } catch (err) {
        deps.logger?.warn?.(`onSessionEvent 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return {
    agentId: agent.id,
    sessionId,
    followup(message) {
      agent.followup(message);
    },
    steer(message) {
      agent.steer(message);
    },
    cancel(cause, options) {
      agent.cancel(cause, options);
    },
    get status() {
      return agent.status;
    },
    whenIdle() {
      return typeof agent.whenIdle === "function" ? agent.whenIdle() : Promise.resolve();
    },
    async dispose() {
      disp();
      await owned.dispose();
    },
  };
}
