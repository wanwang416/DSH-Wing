/**
 * P1-2 模型管理：per-chat live 对象 + GUI 默认同步（ALAN 拍板③）
 *
 * 核心机制（对齐成熟桥接实现）：`installModelSelection({current: liveObj})`
 * 传 **live 对象**，mutate 后无需重建会话，下条回复自动用新模型。
 *
 * - `liveFor(chatId)`：该 chat 的 live 对象（override 优先，否则派生自 GUI 默认，惰性创建）
 * - `setOverride`：/model 手动切换 → mutate live（已存在 agent 生效）+ 持久化 override
 * - `setModelDefault`：GUI 切换 → 刷新**无 override** 的 live（follower 跟随），手动设置的会话不受影响
 * - 轮询：10s 读 `agentDefaultModel.currentSelection()`，sig 变化才触发（参考成熟桥接实现）
 */

export interface ModelSel {
  provider: string;
  model: string;
}

/** "provider/model" 签名解析 → ModelSel（非法返回 undefined） */
export function parseModelSig(sig: string): ModelSel | undefined {
  const sep = sig.indexOf("/");
  if (sep === -1) return undefined;
  const provider = sig.slice(0, sep).trim();
  const model = sig.slice(sep + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

export function formatModelSig(sel: { provider?: string; model?: string } | undefined): string {
  if (!sel?.provider || !sel.model) return "";
  return `${sel.provider}/${sel.model}`;
}

export interface ModelRegistryDeps {
  /** per-chat override 持久化（model-overrides.json） */
  overrides: { get(chatId: string): string | undefined; set(chatId: string, sig: string): void; remove(chatId: string): void };
}

export function createModelRegistry(deps: ModelRegistryDeps) {
  /** GUI 默认模型（10s 轮询更新） */
  let modelDefault: ModelSel | undefined;
  /** chatId → live 对象（override 优先 / default 派生；mutate 即对已存在 agent 生效） */
  const liveCache = new Map<string, ModelSel>();

  return {
    setModelDefault(sel: ModelSel | undefined): void {
      modelDefault = sel;
      // GUI 切换 → 无 override 的 live 跟随（follower 会话；手动设置的不被冲——拍板③）
      if (sel) {
        for (const [chatId, live] of liveCache) {
          if (!deps.overrides.get(chatId)) {
            live.provider = sel.provider;
            live.model = sel.model;
          }
        }
      }
    },
    getModelDefault(): ModelSel | undefined {
      return modelDefault;
    },
    /** 返回 chat 的 live 对象（override 优先，否则派生自默认；惰性创建后稳定复用） */
    liveFor(chatId: string): ModelSel {
      let live = liveCache.get(chatId);
      if (!live) {
        const ovSig = deps.overrides.get(chatId);
        live = ovSig ? (parseModelSig(ovSig) ?? { provider: "", model: "" }) : { provider: modelDefault?.provider ?? "", model: modelDefault?.model ?? "" };
        liveCache.set(chatId, live);
      }
      return live;
    },
    /** /model 手动切换：mutate live（已存在 agent 生效）+ 持久化 override */
    setOverride(chatId: string, sel: ModelSel): void {
      deps.overrides.set(chatId, formatModelSig(sel));
      const live = this.liveFor(chatId);
      live.provider = sel.provider;
      live.model = sel.model;
    },
    clearOverride(chatId: string): void {
      deps.overrides.remove(chatId);
      liveCache.delete(chatId); // 下次 liveFor 重新派生自 GUI 默认
    },
    hasOverride(chatId: string): boolean {
      return Boolean(deps.overrides.get(chatId));
    },
  };
}

export type ModelRegistry = ReturnType<typeof createModelRegistry>;

/** GUI 默认模型同步：10s 轮询 currentSelection，sig 变化才触发 onChange */
export function createModelSync(deps: {
  getGuiModel(): ModelSel | undefined;
  onChange(sel: ModelSel): void;
  pollMs?: number;
  logger?: { info?: (m: string) => void };
}): { start(): void; stop(): void } {
  const pollMs = deps.pollMs ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  let lastSig = "";

  const poll = (): void => {
    try {
      const cur = deps.getGuiModel();
      if (!cur?.provider || !cur.model) return;
      const sig = formatModelSig(cur);
      if (sig === lastSig) return;
      lastSig = sig;
      deps.onChange(cur);
      deps.logger?.info?.(`GUI 模型已切换 → bridge 跟随: ${sig}`);
    } catch {
      // best-effort
    }
  };

  return {
    start(): void {
      if (timer) return;
      poll(); // 首轮立即采样（建默认）
      const t = setInterval(poll, pollMs);
      t.unref?.();
      timer = t;
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
