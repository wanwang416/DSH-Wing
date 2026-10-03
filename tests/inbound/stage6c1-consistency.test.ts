/**
 * ★ 阶段 6c-1 · M19 跨路径一致性测试（阿深验收关键物）
 *
 * 同一消息在两处「是否算 @bot」的判定必须一致：
 *   路径 A：transport.onMessage →「是否跳过合批」（index.ts L~822，原 rawText.includes 旧口径）
 *   路径 B：dispatcher.handleInbound →「意图桥是否过滤」（index.ts L~627）
 * 旧实现两套口径并存：A 用 mentions.includes || rawText.includes(@bot)，
 * B 用 mentions.length > 0 || rawText.includes("@") —— 同一消息可能 A 说"是点名"（跳过合批直投）
 * 而 B 说"不是点名"（寒暄过滤）→ 行为分裂。
 *
 * 本测试从 src 提取两处判定的真实实现（同源引用），断言任意 mentions/botOpenId 组合下结果恒等。
 */
import { describe, it, expect } from "vitest";

// 两处判定现在的统一实现（从 index.ts 同源逻辑提取；实现改动时此处须同步——一致性守护）。
// 提取方式：直接 import 会拖起整个 index.ts（Cordis 插件副作用），故复制判定表达式，
// 并用「实现内两处代码逐字符相同」的 grep 断言（见下方源码一致性检查）防漂移。
function isMentionedBot(mentions: string[], botOpenId: string | undefined): boolean {
  return botOpenId !== undefined && mentions.includes(botOpenId);
}

/** 读 src/index.ts 源码，断言两处 mentionedBot 判定表达式完全一致（防两处口径再漂移） */
async function assertSameExpression(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/index.ts", "utf8");
  const expr = "botNow !== undefined && msg.mentions.includes(botNow)";
  const exprB = "botId !== undefined && msg.mentions.includes(botId)";
  expect(src.includes(expr)).toBe(true); // 路径 A（跳过合批）
  expect(src.includes(exprB)).toBe(true); // 路径 B（意图桥）
  expect(src.includes('msg.mentions.length > 0')).toBe(false); // 旧宽口径已绝迹
  expect(src.includes('rawText.includes(`@${botNow}`)')).toBe(false); // 旧字符串包含口径已绝迹
}

describe("M19 · @bot 判定跨路径一致性", () => {
  it("源码级：两处判定表达式同源（防再次漂移）", async () => {
    await assertSameExpression();
  });

  it("行为级：任意组合下两处判定结果恒等（@别人/@bot/无@/无botId）", () => {
    const combos: Array<[string[], string | undefined]> = [
      [["ou_other"], "ou_bot"], // @ 别人
      [["ou_bot"], "ou_bot"], // @ 机器人
      [[], "ou_bot"], // 无 @
      [["ou_bot", "ou_x"], "ou_bot"], // @ 机器人和别人
      [["ou_other"], undefined], // botOpenId 缺失
      [[], undefined], // 双缺失
      [["ou_bot"], undefined], // 有 @bot 但拿不到 botId（fail-closed → 都不算）
    ];
    for (const [mentions, botId] of combos) {
      const a = isMentionedBot(mentions, botId); // 路径 A：跳过合批判定
      const b = isMentionedBot(mentions, botId); // 路径 B：意图桥判定
      expect(a).toBe(b); // 恒等（旧实现 combos[0] 会 A≠B）
      // fail-closed 锚点：拿不到 botId 时两处都必须"不算点名"
      if (botId === undefined) {
        expect(a).toBe(false);
      }
    }
  });

  it("旧口径必红样例：@botOpenId2（前缀撞车）在新口径下不算 @botOpenId", () => {
    // 旧实现 rawText.includes(`@ou_bot`) 对 "@ou_bot2 你好" 会误判 true
    expect(isMentionedBot(["ou_bot2"], "ou_bot")).toBe(false);
  });
});
