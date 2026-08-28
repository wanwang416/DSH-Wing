/**
 * chat_type 推断（M4 任务 4a 提取为可测纯函数）
 *
 * 飞书 chatId 前缀约定：`oc_` = 群聊（chat_id），`ou_`/其他 = 单聊（open_id）。
 * 与 sender.ts 的 receiveIdType 判断保持同一模式。
 */
export function chatTypeOf(chatId: string): "group" | "p2p" {
  return chatId.startsWith("oc_") ? "group" : "p2p";
}
