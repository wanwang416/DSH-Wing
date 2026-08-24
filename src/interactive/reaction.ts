/**
 * 表情回应管理
 *
 * - react(messageId, emojiType)：加表情，缓存 reaction_id（删除用，M3 完善）
 * - clear(messageId)：删表情（需要 reaction_id，缓存没有则跳过）
 * - 231001 = emoji_type 不支持（飞书限制），静默忽略
 */

export interface ReactionManagerDeps {
  addReaction(messageId: string, emojiType: string): Promise<unknown>;
  removeReaction?(messageId: string, reactionId: string): Promise<unknown>;
  enabled(): boolean;
}

export function createReactionManager(deps: ReactionManagerDeps) {
  /** messageId → {emojiType, reactionId} 缓存 */
  const cache = new Map<string, { emojiType: string; reactionId?: string }>();

  return {
    /** 加表情；返回 reactionId（可能 undefined） */
    async react(messageId: string, emojiType: string): Promise<string | undefined> {
      if (!deps.enabled()) return undefined;
      try {
        const res = (await deps.addReaction(messageId, emojiType)) as any;
        const reactionId = res?.data?.reaction_id ?? res?.reaction_id;
        cache.set(messageId, { emojiType, reactionId });
        return reactionId;
      } catch {
        // 231001 等表情限制，静默忽略
        return undefined;
      }
    },
    /** 删除表情（M3 交互完善） */
    async clear(messageId: string): Promise<void> {
      const rec = cache.get(messageId);
      if (rec?.reactionId && deps.removeReaction) {
        try {
          await deps.removeReaction(messageId, rec.reactionId);
        } catch {
          // 忽略
        }
      }
      cache.delete(messageId);
    },
  };
}

export type ReactionManager = ReturnType<typeof createReactionManager>;
