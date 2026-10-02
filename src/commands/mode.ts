/**
 * /mode <mode> 切换权限模式（P1-2：无参发单选卡；★ 只对新消息生效，当前运行 agent 不变更）
 *
 * 合法模式：read-only / workspace-write / danger-full-access（PermissionMode 三选一）
 * - 无参 → 权限单选卡（点选即切换）
 * - 带合法参数 → 文本切换（兼容旧用法）
 * - 非法参数 → 提示
 *
 * ★ X5（阶段5）安全语义（ALAN 拍板）：
 * - 权限按**会话**各自生效（per-chat override，落盘保留，重启仍在）
 * - 降级/常规（read-only、workspace-write）→ 任何人可改自己所在会话
 * - 升到 danger-full-access → 只有老板可以；身份取不到/未配置 → 拒绝（fail-closed）
 *
 * ★ M40（阶段5）：内置默认 preset（DEFAULT_PERMISSION_PRESETS）——read-only 档不再依赖
 *   部署侧额外 preset；部署侧 permissionPresets 若有同名配置仍以其为准（宿主 resolve 行为）。
 */
import type { BridgeCommandDef } from "./types.js";
import { permissionModeLabel, PERMISSION_THREE_LEVELS } from "./labels.js";
import { buildSelectorCard } from "../interactive/selector.js";

const VALID_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

const MODE_ITEMS = [
  { id: "read-only", label: "只读", desc: "只能查看和提问，不能改文件、不能执行命令" },
  { id: "workspace-write", label: "工作区读写", desc: "可在当前项目内读写文件、执行命令（默认）" },
  { id: "danger-full-access", label: "完全访问", desc: "无限制，可执行任何操作（仅限老板本人开启）" },
];

export const modeCommand: BridgeCommandDef = {
  name: "mode",
  description: "切换本会话权限模式：/mode（选卡）｜/mode read-only｜workspace-write｜danger-full-access",
  async run(deps, rawInput, msg) {
    const runtime = deps.services?.runtime;
    if (!runtime) return { text: "⚠️ 权限服务不可用，请稍后再试" };

    const chatId = msg.chatId;
    const operatorId = msg.userId;
    const arg = rawInput.trim().toLowerCase();
    // 带参数 → 文本切换（保持兼容）
    if (arg) {
      // 参数非法 → 提示（不吞）
      if (!(VALID_MODES as readonly string[]).includes(arg)) {
        return {
          text: `⚠️ 未知模式「${rawInput.trim()}」\n可用模式：read-only｜workspace-write｜danger-full-access`,
        };
      }
      // ★ X5：提权校验（共用判定，与卡片回调同源）——先校验，后落盘
      if (runtime.checkPermissionChange) {
        const deny = runtime.checkPermissionChange(arg, operatorId);
        if (deny) {
          deps.logger?.warn?.(`/mode 提权被拒 chat=${chatId} target=${arg} operator=${operatorId ?? "unknown"}（X5 fail-closed）`);
          return { text: `🚫 ${deny}` };
        }
      }
      // 设置成功 → 注明只对**本会话**新消息生效
      const ok = runtime.setPermissionMode(arg, chatId);
      if (!ok) return { text: "⚠️ 权限模式更新失败，请稍后再试" };
      return {
        // ★ M40：不写死「已生效」——真正应用在新会话创建时（applyPermission），若 preset 缺失
        //   会 warn「未生效」并维持默认权限；此处措辞只声明"已记录"。
        text: `**本会话**权限已记录为「${permissionModeLabel(arg)}」\n📌 对**本会话**后续新消息生效，其他会话不受影响，重启后仍保留。\n⚠️ 若该档位在部署侧不可用，将维持默认权限（日志可见「未生效」留痕）。`,
      };
    }

    // 无参数 → 权限单选卡（当前项置灰 ✓；★ X5：读本会话解析值）
    const cur = runtime.getPermissionModeFor ? runtime.getPermissionModeFor(chatId) : runtime.getPermissionMode();
    return {
      card: buildSelectorCard({
        header: "🔐 切换本会话权限模式",
        title: `本会话当前模式：**${permissionModeLabel(cur)}**（仅本会话生效）\n${PERMISSION_THREE_LEVELS[0]}\n${PERMISSION_THREE_LEVELS[1]}\n${PERMISSION_THREE_LEVELS[2]}\n点按钮即切换；完全访问仅限老板本人开启。`,
        items: MODE_ITEMS.map((it) => ({ ...it, current: it.id === cur })),
        opPrefix: "mode",
        template: "turquoise",
      }),
    };
  },
};
