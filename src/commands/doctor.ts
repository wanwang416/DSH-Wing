/**
 * /doctor 一键生成诊断包（M4.2 任务 2：P0）
 *
 * 打包日志（tail）+ 脱敏配置 + 环境信息 → ZIP，回复本地路径。
 * 用户把 ZIP 发给 AI 助手或附在 issue 即可定位问题。
 * 真机发 ZIP 文件走飞书文件通道（待接入），本命令先返回文件路径。
 */
import type { BridgeCommandDef } from "./types.js";

export const doctorCommand: BridgeCommandDef = {
  name: "doctor",
  description: "一键生成诊断包：/doctor（打包日志+脱敏配置+环境，贴给 AI 即可定位）",
  async run(deps, rawInput, msg) {
    const gen = deps.services?.doctor?.generate;
    if (!gen) return { text: "⚠️ 诊断服务不可用，请稍后再试" };
    const r = await gen(msg.chatId);
    const kb = (r.size / 1024).toFixed(1);
    return {
      text: `📦 诊断包已生成（${kb} KB）\n\`${r.zipPath}\`\n\n用法：把 ZIP 发给 AI 助手，或连同 issue 一起提交。配置中的 app_secret / token 已脱敏。`,
    };
  },
};
