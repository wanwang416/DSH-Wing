/**
 * P1-2 单选卡框架测试（buildSelectorCard + parseOp）
 */
import { describe, expect, it } from "vitest";
import { buildSelectorCard, parseOp } from "../../src/interactive/selector.js";

describe("buildSelectorCard", () => {
  it("schema 2.0 结构：header + 说明 + 每项一个 callback 按钮", () => {
    const card = buildSelectorCard({
      header: "🔐 权限模式",
      title: "点按钮即切换",
      items: [
        { id: "read-only", label: "只读", desc: "只能查看" },
        { id: "workspace-write", label: "工作区读写" },
      ],
      opPrefix: "mode",
    });
    expect(card.schema).toBe("2.0");
    expect((card.header as any).title.content).toBe("🔐 权限模式");
    const els = (card.body as any).elements as any[];
    // 第 0 个元素是说明 markdown；第 1 个是选项列表 markdown
    expect(els[0].tag).toBe("markdown");
    expect(els[0].content).toBe("点按钮即切换");
    // 选项列表含 label + desc
    expect(els[1].content).toContain("只读");
    expect(els[1].content).toContain("只能查看");
    // 两个按钮
    const buttons = els.slice(2) as any[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].tag).toBe("button");
    expect(buttons[0].text.content).toBe("只读");
    expect(buttons[0].behaviors[0].type).toBe("callback");
    expect(buttons[0].behaviors[0].value.op).toBe("mode:read-only");
    expect(buttons[1].behaviors[0].value.op).toBe("mode:workspace-write");
  });

  it("current 项 → primary + ✓ 标记 + disabled", () => {
    const card = buildSelectorCard({
      header: "h",
      items: [
        { id: "a", label: "A", current: true },
        { id: "b", label: "B" },
      ],
      opPrefix: "mode",
    });
    const els = (card.body as any).elements as any[];
    // 无 title → [选项列表, 按钮A, 按钮B]
    const [a, b] = els.slice(1) as any[];
    expect(a.type).toBe("primary");
    expect(a.text.content).toBe("A ✓");
    expect(a.disabled).toBe(true);
    expect(b.type).toBe("default");
    expect(b.disabled).toBe(false);
    // 选项列表（els[0]）标「← 当前」
    expect(els[0].content).toContain("← 当前");
  });

  it("broken 项 → disabled（不可选）", () => {
    const card = buildSelectorCard({
      header: "h",
      items: [{ id: "x", label: "X", broken: "依赖缺失" }],
      opPrefix: "preset",
    });
    const els = (card.body as any).elements as any[];
    // 无 title → [选项列表, 按钮X]
    expect(els[0].content).toContain("不可用：依赖缺失");
    expect(els[1].disabled).toBe(true);
  });

  it("无 title → 无说明元素，直接从选项列表开始", () => {
    const card = buildSelectorCard({
      header: "h",
      items: [{ id: "a", label: "A" }],
      opPrefix: "model",
    });
    const els = (card.body as any).elements as any[];
    expect(els[0].tag).toBe("markdown"); // 选项列表
    expect(els[0].content).toContain("A");
  });
});

describe("parseOp", () => {
  it("带冒号 → 拆分 cmd/arg", () => {
    expect(parseOp("mode:read-only")).toEqual({ cmd: "mode", arg: "read-only" });
    expect(parseOp("model:deepseek/deepseek-chat")).toEqual({ cmd: "model", arg: "deepseek/deepseek-chat" });
  });
  it("无冒号 → arg 为空串", () => {
    expect(parseOp("preset")).toEqual({ cmd: "preset", arg: "" });
  });
});
