/**
 * chat_type 兜底推断（M4 任务 4a 提取为可测纯函数）
 *
 * ⚠️ 仅用于「无事件层真实 chatType」时的兜底猜测，**不可靠**：
 * 飞书 P2P 会话的 chat_id 同样是 `oc_` 前缀（实测 routes.json：ALAN P2P 会话
 * chatId=oc_1310… chatType=p2p），因此 oc_ 前缀不能区分群聊/单聊。
 * 合批 flush 等链路必须透传事件层 message.chat_type 真值（batching.ts BatchItem.chatType），
 * 不要依赖本函数做语义判断。与 sender.ts 的 receiveIdType 判断保持同一模式。
 */
export function chatTypeOf(chatId: string): "group" | "p2p" {
  return chatId.startsWith("oc_") ? "group" : "p2p";
}
