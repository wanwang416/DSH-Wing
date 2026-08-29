/**
 * P1-2 通用单选卡框架（点按钮即切换，不弹打字）
 *
 * 三个命令复用：/mode /permission（权限单选卡）、/model（模型单选卡）、/preset（预设单选卡）。
 * 参考  成熟桥接presentation/cards.ts：modelCard（带 callback 按钮）+ button()/withButtons()。
 *
 * 结构（schema 2.0）：
 *   header.title + body.elements：
 *     - markdown 说明（当前值 + 提示「点按钮即切换」）
 *     - 每项一个 button：behaviors:[{type:"callback", value:{op:"<opPrefix>:<id>"}}]
 *       current 项 / broken 项 → disabled（防重复切换）
 *
 * ★ 关键坑（ 成熟桥接踩过）：回调回复的 dedupeKey 必须带唯一 token（card messageId），
 *   否则同一张卡点两次第二次被 durableReply 去重吞掉、用户拿不到确认。
 */

export interface SelectorItem {
  id: string;
  label: string;
  desc?: string;
  /** 当前选中项（按钮置灰防重复切换） */
  current?: boolean;
  /** 不可用（如 broken preset）→ 按钮禁用 */
  broken?: string;
}

export interface BuildSelectorCardOpts {
  /** 卡片标题（header.title） */
  header: string;
  /** 说明第一行（markdown，显示当前值 + 提示） */
  title?: string;
  items: SelectorItem[];
  /** 回调 op 前缀（mode/permission/model/preset），按钮 value.op = `${opPrefix}:${item.id}` */
  opPrefix: string;
  /** 模板色（默认 blue；权限高危可传 red） */
  template?: string;
}

/** 构建单选卡（schema 2.0：说明 + 每项一个 callback 按钮） */
export function buildSelectorCard(opts: BuildSelectorCardOpts): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  if (opts.title) {
    elements.push({ tag: "markdown", content: opts.title });
  }
  // 选项列表说明（label + desc + 当前标记）
  const list = opts.items
    .map((it) => {
      const cur = it.current ? " ← 当前" : "";
      const broken = it.broken ? `（不可用：${it.broken}）` : "";
      return `- **${it.label}**${cur}${broken}${it.desc ? `：${it.desc}` : ""}`;
    })
    .join("\n");
  if (list) elements.push({ tag: "markdown", content: list });
  // 每项一个按钮（点选即切换，current/broken 禁用）
  for (const it of opts.items) {
    const disabled = Boolean(it.current) || Boolean(it.broken);
    elements.push({
      tag: "button",
      type: it.current ? "primary" : "default",
      width: "fill",
      disabled,
      text: { tag: "plain_text", content: it.current ? `${it.label} ✓` : it.label },
      behaviors: [
        {
          type: "callback",
          value: { op: `${opts.opPrefix}:${it.id}` },
        },
      ],
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: opts.header }, template: opts.template ?? "blue" },
    body: { elements },
  };
}

/** 解析卡片回调 op：`<cmd>:<arg>` → {cmd, arg}（无冒号 → arg=""） */
export function parseOp(op: string): { cmd: string; arg: string } {
  const sep = op.indexOf(":");
  if (sep === -1) return { cmd: op, arg: "" };
  return { cmd: op.slice(0, sep), arg: op.slice(sep + 1) };
}
