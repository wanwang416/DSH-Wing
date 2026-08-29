/**
 * ★ ALAN 灵魂设计：任务中断四类分类（command/question/confirm/ordinary）
 *
 * 24 条用例（每类 6 条，参考阿深桥 v2），分类错误率必须为 0%。
 * 边界用例：大小写 / 空白 / 空串 / 前缀包含 / 纯确认词 vs 推进词。
 */
import { describe, expect, it } from "vitest";
import {
  classifyInterrupt,
  InterruptType,
  isForwardWord,
  isRedirectWord,
} from "../../src/inbound/interrupt-classify.js";

describe("interrupt-classify · 24 条用例（每类 6 条，分类错误率 0%）", () => {
  it("COMMAND：停 / 停止 / 停下来 / 别写了 / 换个话题 / 重新来", () => {
    for (const w of ["停", "停止", "停下来", "别写了", "换个话题", "重新来"]) {
      expect(classifyInterrupt(w), `「${w}」应分类为 COMMAND`).toBe(InterruptType.COMMAND);
    }
  });

  it("QUESTION：为什么 / 怎么做 / 是什么 / 能解释一下吗 / 请问 / 可以问一下吗", () => {
    for (const w of ["为什么", "怎么做", "是什么", "能解释一下吗", "请问", "可以问一下吗"]) {
      expect(classifyInterrupt(w), `「${w}」应分类为 QUESTION`).toBe(InterruptType.QUESTION);
    }
  });

  it("CONFIRM：这样对吗 / 可以吗 / 你确定 / 是不是 / 这样行吗 / 确认一下", () => {
    for (const w of ["这样对吗", "可以吗", "你确定", "是不是", "这样行吗", "确认一下"]) {
      expect(classifyInterrupt(w), `「${w}」应分类为 CONFIRM`).toBe(InterruptType.CONFIRM);
    }
  });

  it("ORDINARY：继续 / 知道了 / 好的 / 收到 / 明白 / 嗯", () => {
    for (const w of ["继续", "知道了", "好的", "收到", "明白", "嗯"]) {
      expect(classifyInterrupt(w), `「${w}」应分类为 ORDINARY`).toBe(InterruptType.ORDINARY);
    }
  });
});

describe("interrupt-classify · 边界用例", () => {
  it("空串 / 纯空白 → null（非中断）", () => {
    expect(classifyInterrupt("")).toBeNull();
    expect(classifyInterrupt("   ")).toBeNull();
    expect(classifyInterrupt("\n\t")).toBeNull();
  });

  it("大小写不敏感：STOP → COMMAND", () => {
    expect(classifyInterrupt("STOP")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("Stop")).toBe(InterruptType.COMMAND);
  });

  it("前后空白裁剪后仍能分类", () => {
    expect(classifyInterrupt("  停  ")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("  为什么  ")).toBe(InterruptType.QUESTION);
  });

  it("历史停止词兼容：/stop / 算了 / stop", () => {
    expect(classifyInterrupt("/stop")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("算了")).toBe(InterruptType.COMMAND);
    expect(classifyInterrupt("stop")).toBe(InterruptType.COMMAND);
  });

  it("QUESTION 前缀匹配：为什么这样做 → QUESTION", () => {
    expect(classifyInterrupt("为什么这样做")).toBe(InterruptType.QUESTION);
    expect(classifyInterrupt("怎么做这道题")).toBe(InterruptType.QUESTION);
    expect(classifyInterrupt("请问现在几点了")).toBe(InterruptType.QUESTION);
  });

  it("CONFIRM 包含匹配：这样真的可以吗 → CONFIRM", () => {
    expect(classifyInterrupt("这样真的可以吗")).toBe(InterruptType.CONFIRM);
    expect(classifyInterrupt("你确定吗")).toBe(InterruptType.CONFIRM);
  });

  it("分类优先级：QUESTION 先于 CONFIRM（可以问一下吗 不是 CONFIRM）", () => {
    expect(classifyInterrupt("可以问一下吗")).toBe(InterruptType.QUESTION);
    expect(classifyInterrupt("能解释一下吗")).toBe(InterruptType.QUESTION);
  });

  it("非精确词不误分类：继续写下去 → null（走原插话逻辑）", () => {
    expect(classifyInterrupt("继续写下去")).toBeNull();
    expect(classifyInterrupt("好的吧")).toBeNull();
    expect(classifyInterrupt("嗯嗯")).toBeNull();
  });
});

describe("interrupt-classify · 子类型助手（豆包细分拍板）", () => {
  it("isForwardWord：推进词 继续/接着来/往下 → true，纯确认词 → false", () => {
    expect(isForwardWord("继续")).toBe(true);
    expect(isForwardWord("接着来")).toBe(true);
    expect(isForwardWord("往下")).toBe(true);
    expect(isForwardWord("好的")).toBe(false);
    expect(isForwardWord("知道了")).toBe(false);
    expect(isForwardWord("嗯")).toBe(false);
  });

  it("isRedirectWord：改道词 换个话题/重新来 → true，停止词 → false", () => {
    expect(isRedirectWord("换个话题")).toBe(true);
    expect(isRedirectWord("重新来")).toBe(true);
    expect(isRedirectWord("停")).toBe(false);
    expect(isRedirectWord("停止")).toBe(false);
  });
});
