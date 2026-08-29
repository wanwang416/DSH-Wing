/**
 * P1-2 preset 管理（ALAN 拍板①：读真实 roster + 兜底 4 档）
 *
 * 真实 roster：ctx.get("agentPresets").list()（shipped + 用户自定义，GUI 新建的 preset 也能用）。
 * 服务不可用/失败 → 兜底 SHIPPED_PRESETS（4 档出厂，对齐  成熟桥接成熟桥接.ts:107）。
 */

export interface PresetOption {
  id: string;
  label: string;
  desc?: string;
  trust?: "system" | "user";
  broken?: string;
}

/** 出厂 4 档（ALAN 拍板①：实际产品 4 档，不写死 3 档过时方案） */
export const SHIPPED_PRESETS: PresetOption[] = [
  { id: "standard", label: "标准模式", desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流", trust: "system" },
  { id: "code", label: "PTC 模式", desc: "标准能力 + Code Mode（多步操作一次执行，更快）", trust: "system" },
  { id: "minimal", label: "极简模式", desc: "仅 bash + 文件编辑，轻量省 token", trust: "system" },
  { id: "cordis", label: "创造模式", desc: "标准能力 + preset 创作工具（面向开发者）", trust: "system" },
];

/** DSH agentPresets 服务最小面（list 返回 {id,name,description,trust,broken}[]） */
interface AgentPresetsServiceLike {
  list?(): Promise<Array<{ id: string; trust?: "system" | "user"; name?: string; description?: string; broken?: string }>>;
}

/**
 * 读真实 preset roster；服务不可用/失败 → 兜底 4 档。
 * @returns 空数组仅当服务存在但返回空（上层可 fallback SHIPPED_PRESETS）
 */
export async function listPresets(
  ctx: { get?(name: string): unknown } | undefined,
  logger?: { warn?: (m: string) => void },
): Promise<PresetOption[]> {
  const svc = ctx?.get?.("agentPresets") as AgentPresetsServiceLike | undefined;
  if (!svc?.list) return [...SHIPPED_PRESETS];
  try {
    const rows = await svc.list();
    return rows.map((row) => ({
      id: row.id,
      label: row.name ?? row.id,
      ...(row.trust === undefined ? {} : { trust: row.trust }),
      ...(row.description === undefined ? {} : { desc: row.description }),
      ...(row.broken === undefined ? {} : { broken: row.broken }),
    }));
  } catch (err) {
    logger?.warn?.(`agentPresets.list() 失败，兜底 4 档: ${err instanceof Error ? err.message : String(err)}`);
    return [...SHIPPED_PRESETS];
  }
}

/** id → 中文名（preset 单选卡/回执用；找不到返回原 id） */
export function presetLabel(id: string, presets: readonly PresetOption[]): string {
  return presets.find((p) => p.id === id)?.label ?? id;
}
