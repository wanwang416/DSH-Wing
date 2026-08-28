/**
 * 事件处理（M4 任务 6 提取重构：从 index.ts 抽出，独立可测）
 *
 * 覆盖 5 类事件：
 * - im.chat.member.bot.added_v1：bot 被拉进群 → 欢迎消息
 * - im.chat.access_event.bot_p2p_chat_entered_v1：P2P 进入 → 欢迎消息
 * - card.action.trigger：ask-user-question 选项点击 → 消费待答 Promise 或 steer 注入 agent
 * - im.message.recalled_v1：消息撤回 → 停止该 chat 正在生成的 agent（非阻塞）
 * - 其余（reaction/read 等）：日志级响应
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { WingAgentHandle } from "../agent/caller.js";

export interface EventHandlerDeps {
  outbox: {
    enqueue(env: { dedupeKey: string; chatId: string; kind: "text"; payload: { kind: "text"; text: string } }): unknown;
  };
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
  mapper?: {
    getOrCreateAgent(chatId: string): Promise<WingAgentHandle>;
    get(chatId: string): WingAgentHandle | undefined;
  };
  userQuestionBridge?: { onCardAction(chatId: string, actionName: string): boolean };
  experience?: { handleUserMessage(chatId: string, agent: WingAgentHandle, text: string, message: unknown): string };
}

export function createEventHandler(deps: EventHandlerDeps) {
  const { outbox, logger, mapper, userQuestionBridge, experience } = deps;

  return function onEvent(event: string, data: unknown): void {
    // M2 订阅：表情/撤回/bot进退群/P2P/已读/card.action.trigger（ask-user-question 需要）
    const d = data as any;
    const chatIdOf = (): string | undefined => d?.chat_id ?? d?.chat?.chat_id ?? d?.operator?.operator_id?.open_id;
    switch (event) {
      case "im.chat.member.bot.added_v1": {
        const chatId = chatIdOf();
        if (chatId) {
          void outbox.enqueue({
            dedupeKey: `${chatId}:welcome:${Date.now()}`,
            chatId,
            kind: "text",
            payload: { kind: "text", text: "👋 我是 dsh-wing，随时待命！" },
          });
        }
        break;
      }
      case "im.chat.access_event.bot_p2p_chat_entered_v1": {
        const openId = d?.operator?.operator_id?.open_id;
        if (openId) {
          void outbox.enqueue({
            dedupeKey: `p2p:${openId}:welcome:${Date.now()}`,
            chatId: openId,
            kind: "text",
            payload: { kind: "text", text: "👋 你好！我是 dsh-wing，直接说需求就行。" },
          });
        }
        break;
      }
      case "card.action.trigger": {
        // 处理 ask-user-question 选项点击 → 把用户选择注入 agent
        // ★ 诊断日志：打印完整事件结构，定位"点击无响应"卡在哪一步
        logger?.info?.(`card.action.trigger 收到事件 data=${JSON.stringify(d).slice(0, 1000)}`);
        try {
          // ★ schema 2.0 card.action.trigger 标准路径（参考 dsh-im bridge.mjs onCardAction）：
          //   chatId = event.context.open_chat_id
          //   action = event.action.value.action
          // 兼容旧路径（schema 1.0 / 不同 SDK 版本）
          const chatId =
            (d as any).context?.open_chat_id ??
            (d as any).open_chat_id ??
            (d as any).chat_id ??
            d?.chat?.chat_id ??
            (d as any).message?.chat_id ??
            (d as any).event?.open_chat_id ??
            (d as any).event?.chat_id;
          if (!chatId) {
            logger?.warn?.(`card.action.trigger: 取不到 chatId，事件字段不匹配。可用键=${Object.keys(d).join(",")}`);
            break;
          }
          // action 名：schema 2.0 从 action.value.action 取，兼容旧版 action.name
          const actionName =
            d.action?.value?.action ??
            d.action?.name ??
            (d as any).event?.action?.value?.action ??
            (d as any).event?.action?.name;
          // answer: 前缀 = 提问卡片选项按钮（M4-R4 灾难回退：feedback:/form_values 已随 form 移除）
          if (!actionName || !actionName.startsWith("answer:")) {
            logger?.warn?.(`card.action.trigger: actionName 不匹配 answer: 前缀，actionName=${actionName ?? "undefined"}`);
            break;
          }
          logger?.info?.(`card.action.trigger: chatId=${chatId} actionName=${actionName}`);
          // ★ M3 任务 1：先让提问桥 resolve 待答 Promise + 更新卡片"✅ 已选择"；已消费则不再 steer
          if (userQuestionBridge?.onCardAction(chatId, actionName)) break;
          // value：schema 2.0 已经是对象 {action, questionId, optionId, label}
          const value = d.action?.value ?? (d as any).event?.action?.value ?? null;
          if (!value?.label) {
            logger?.warn?.(`card.action.trigger: value 无 label，value=${JSON.stringify(value)}`);
            break;
          }
          // 用户选择了: value.label → 作为文本 steer 注入 agent（兜底：无待答问题时保持 M2 行为）
          // 1) 获取 agent
          (async () => {
            const agent = await mapper!.getOrCreateAgent(chatId);
            // 2) 构造消息
            const message = createUserMessage({
              content: [{ type: "text", text: value.label }],
              source: { kind: "user" },
            });
            // 3) steer 注入（agent 正在运行 → next-step 边界消费）
            experience?.handleUserMessage(chatId, agent, value.label, message);
            // ★ R5.1：日志必须诚实——此处只代表已提交，无法确认 agent 消费；agent 空闲时可能无人接（Q3 缺口，M5 插话方案处理）
            logger?.info?.(`card.action.trigger chat=${chatId} question=${value.questionId} option=${value.optionId} label=${value.label} → steer 已提交（agent 空闲时不保证消费，见 M5）`);
          })().catch((err) => {
            logger?.warn?.(`card.action.trigger 处理失败: ${err instanceof Error ? err.message : String(err)}`);
          });
          break;
        } catch (err) {
          logger?.warn?.(`card.action.trigger 解析失败: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
      case "im.message.recalled_v1": {
        // ★ M4 任务 6：消息撤回 → 停止该 chat 正在生成的 agent（非阻塞；无 agent 则跳过）
        // chatIdOf() 覆盖 chat_id / chat.chat_id / operator.open_id；recalled 事件字段在 message.chat_id
        const chatId = chatIdOf() ?? (d as any)?.message?.chat_id;
        const msgId = d?.message?.message_id ?? d?.message_id ?? "?";
        if (!chatId) {
          logger?.warn?.(`im.message.recalled_v1 取不到 chatId，跳过`);
          break;
        }
        const handle = mapper?.get(chatId);
        if (handle) {
          try {
            handle.cancel({ kind: "recalled" });
            logger?.info?.(`消息撤回 msg=${msgId} chat=${chatId} → 已停止 agent 生成`);
          } catch (err) {
            logger?.warn?.(`消息撤回停止 agent 失败 chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          logger?.info?.(`消息撤回 msg=${msgId} chat=${chatId}（无进行中 agent，跳过）`);
        }
        break;
      }
      default:
        // reaction/read/bot_deleted：日志级响应（M2 验收 15）
        logger?.info?.(`事件 ${event} 收到（${JSON.stringify(d)?.slice(0, 120) ?? ""}）`);
        break;
    }
  };
}
