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
      const mentioned = msg.mentions.includes(botOpenId ?? "") || (botOpenId ? msg.rawText.includes(`@${botOpenId}`) : false);
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
