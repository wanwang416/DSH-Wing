/**
 * 群策略（M2：open / mention / keywords / reply）
 *
 * 决定群消息是否触发处理：
 * - open：群里任何消息都处理
 * - mention：仅 @bot 时处理
 * - keywords：含配置关键词时处理
 * - reply：仅回复 bot 消息时处理
 */

import type { GroupPolicy } from "../config/defaults.js";
import type { ParsedMessage } from "./parser.js";

export interface GroupPolicyDeps {
  policy: () => GroupPolicy;
  keywords: () => string[];
  botOpenId: () => string | undefined;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export function shouldProcessGroupMessage(msg: ParsedMessage, deps: GroupPolicyDeps): boolean {
  if (msg.chatType !== "group") return true; // p2p 总是处理
  const policy = deps.policy();
  const botOpenId = deps.botOpenId();

  switch (policy) {
    case "open":
      return true;
    case "mention": {
      // ★ M19（阶段6c-1）收窄：只认「确实 @ 到机器人本人」。
      //   旧实现 `mentions.length > 0` 把「@ 了别人」也当成 @bot → 未点名也触发。
      //   企微适配说明：企微 mentions 提取（extractWecomMentions）在有 botName 时
      //   只收「@botName」的精确命中 → mentions 非空即 @bot，语义自洽；
      //   未配 botName 的宽松形态（S5）经 index 侧 botOpenId 检查兜底（企微 botOpenId
      //   为 undefined → 不算点名，宁过滤不误触发）。
      const mentioned = botOpenId !== undefined && msg.mentions.includes(botOpenId);
      return mentioned;
    }
    case "keywords": {
      const keys = deps.keywords();
      return keys.some((k) => msg.text.includes(k));
    }
    case "reply": {
      // reply：parentId 存在（回复消息）且回复的是 bot（简化：有回复即处理）
      return Boolean(msg.parentId) || msg.mentions.length > 0;
    }
    default:
      return true;
  }
}

export function createGroupPolicy(deps: GroupPolicyDeps) {
  return {
    shouldProcess: (msg: ParsedMessage) => shouldProcessGroupMessage(msg, deps),
  };
}

export type GroupPolicyChecker = ReturnType<typeof createGroupPolicy>;
