/**
 * P1-3 意图桥测试（command/question/chitchat/task 四分类 + 寒暄边界防误判）
 */
import { describe, expect, it } from "vitest";
import { classifyIntent, isChitchat, isQuestionLike, Intent } from "../../src/agent/intent.js";

describe("classifyIntent 四分类", () => {
  it("空消息 → CHITCHAT", () => {
    expect(classifyIntent("")).toBe(Intent.CHITCHAT);
    expect(classifyIntent("   ")).toBe(Intent.CHITCHAT);
  });

  it("命令前缀 → COMMAND", () => {
    expect(classifyIntent("/stop")).toBe(Intent.COMMAND);
    expect(classifyIntent("/mode read-only")).toBe(Intent.COMMAND);
  });

  it("精确疑问前缀 → QUESTION", () => {
    expect(classifyIntent("为什么成本这么高")).toBe(Intent.QUESTION);
    expect(classifyIntent("怎么做这个报表")).toBe(Intent.QUESTION);
    expect(classifyIntent("是什么原因")).toBe(Intent.QUESTION);
    expect(classifyIntent("请问怎么配置")).toBe(Intent.QUESTION);
  });

  it("宽泛疑问句式（问号/…吗/…呢）→ QUESTION", () => {
    expect(classifyIntent("帮我算下这个成本吗？")).toBe(Intent.QUESTION);
    expect(classifyIntent("这个方案行不行呢")).toBe(Intent.QUESTION);
    expect(classifyIntent("今天的库存多少？")).toBe(Intent.QUESTION);
  });

  it("纯寒暄 → CHITCHAT（先于宽泛疑问判定）", () => {
    expect(classifyIntent("你好")).toBe(Intent.CHITCHAT);
    expect(classifyIntent("在吗")).toBe(Intent.CHITCHAT); // 招呼不是提问
    expect(classifyIntent("在不在")).toBe(Intent.CHITCHAT);
    expect(classifyIntent("谢谢啦")).toBe(Intent.CHITCHAT);
    expect(classifyIntent("哈哈 好的")).toBe(Intent.CHITCHAT);
    expect(classifyIntent("早上好")).toBe(Intent.CHITCHAT);
  });

  it("真实任务 → TASK", () => {
    expect(classifyIntent("帮我看下这个文件里的问题")).toBe(Intent.TASK);
    expect(classifyIntent("写个脚本统计库存")).toBe(Intent.TASK);
    expect(classifyIntent("把今天的日报生成出来")).toBe(Intent.TASK);
    expect(classifyIntent("分析下这个数据的趋势")).toBe(Intent.TASK);
  });
});

describe("isChitchat 寒暄判定边界（保守防误判）", () => {
  it("词表精确命中", () => {
    expect(isChitchat("你好")).toBe(true);
    expect(isChitchat("在吗")).toBe(true);
    expect(isChitchat("谢谢")).toBe(true);
    expect(isChitchat("666")).toBe(true);
    expect(isChitchat("ok")).toBe(true);
  });

  it("词 + 后缀变体", () => {
    expect(isChitchat("你好呀")).toBe(true);
    expect(isChitchat("好的啦")).toBe(true);
    expect(isChitchat("谢谢啊")).toBe(true);
  });

  it("长句 / 含任务词 → 不算寒暄（防误吞）", () => {
    expect(isChitchat("你好帮我看看这个报表怎么做")).toBe(false);
    expect(isChitchat("谢谢你的帮助但还有问题")).toBe(false);
    expect(isChitchat("好的那就开始写代码吧")).toBe(false);
  });

  it("空串 → false（由 classifyIntent 判空）", () => {
    expect(isChitchat("")).toBe(false);
  });
});

describe("isQuestionLike 疑问句式", () => {
  it("问号结尾", () => {
    expect(isQuestionLike("真的吗？")).toBe(true);
    expect(isQuestionLike("搞定了?")).toBe(true);
  });
  it("吗/呢 结尾", () => {
    expect(isQuestionLike("这样可以吗")).toBe(true);
    expect(isQuestionLike("然后呢")).toBe(true);
  });
  it("疑问代词", () => {
    expect(isQuestionLike("哪里有配置")).toBe(true);
    expect(isQuestionLike("下一步怎么办")).toBe(true);
  });
  it("陈述句 → false", () => {
    expect(isQuestionLike("好的")).toBe(false);
    expect(isQuestionLike("在吗")).toBe(false); // 招呼
    expect(isQuestionLike("帮我看下这个")).toBe(false);
  });
});
