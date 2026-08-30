/**
 * /setup 扫码建应用 · addons 配置（M4.2）
 *
 * 参考 dsh-lark-link auth-setup.ts：创建应用时通过 addons 一次性配置
 * 权限 scope + 事件订阅 + 回调，无需事后去开放平台手动勾选。
 *
 * 事件清单对齐 dsh-wing 实际订阅（src/host/websocket.ts SUBSCRIBED_EVENTS）。
 */

/** registerApp addons 载荷（对齐 @larksuiteoapi/node-sdk registerApp 约定） */
export interface SetupAddons {
  preset?: boolean;
  scopes?: { tenant?: string[]; user?: string[] };
  events?: { items?: { tenant?: string[]; user?: string[] } };
  callbacks?: { items: string[] };
}

/** 桥必需消息事件订阅（缺它 bot 收不到消息） */
export const REQUIRED_EVENT = "im.message.receive_v1";

/** dsh-wing 全部订阅事件（与 websocket.ts SUBSCRIBED_EVENTS 对齐） */
export const SETUP_EVENTS: readonly string[] = [
  REQUIRED_EVENT,
  "im.message.recalled_v1",
  "im.chat.member.bot.added_v1",
  "im.chat.access_event.bot_p2p_chat_entered_v1",
  "im.message.reaction.created_v1",
] as const;

/** 桥依赖权限 scope（消息收发 + 群/私聊 + 资源 + 表情回执） */
export const SETUP_SCOPES: readonly string[] = [
  "im:message",
  "im:message.send_as_bot",
  "im:message.p2p_msg", // P2P 私聊
  "im:message.group_at_msg", // 群 @bot
  "im:message.group_msg", // 群消息全量（policy=open 时无需 @）
  "im:chat",
  "im:resource",
  "im:message.reactions:write_only", // DONE / 回执表情
] as const;

/** 构建 addons（纯函数，可单测） */
export function buildSetupAddons(): SetupAddons {
  return {
    scopes: { tenant: [...SETUP_SCOPES] },
    events: { items: { tenant: [...SETUP_EVENTS] } },
    callbacks: { items: ["card.action.trigger"] },
  };
}
