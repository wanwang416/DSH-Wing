/**
 * 命令回复中文映射（铁律 12：对 Alan 讲人话，不堆英文术语）
 * status / mode / permission 三个命令复用。
 */

/** 权限模式 → 中文说明（/status /mode /permission 用） */
export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case "read-only":
      return "只读（只能查看提问）";
    case "workspace-write":
      return "工作区读写（可在当前项目内执行）";
    case "danger-full-access":
      return "完全访问（无限制，高风险）";
    default:
      return mode;
  }
}

/** 权限模式 → 简短中文名（/status 用，一行内不换行） */
export function permissionModeShort(mode: string): string {
  switch (mode) {
    case "read-only":
      return "只读";
    case "workspace-write":
      return "工作区读写";
    case "danger-full-access":
      return "完全访问";
    default:
      return mode;
  }
}

/** 连接状态 → 中文（/status 用） */
export function connStateLabel(state: string): string {
  switch (state) {
    case "connected":
      return "已连接 ✅";
    case "connecting":
      return "连接中…";
    case "degraded":
      return "信号弱（正在检查）";
    case "disconnected":
      return "已断开 ⚠️";
    case "stopped":
      return "已停止";
    default:
      return state;
  }
}

/** 权限三级说明（/permission 用） */
export const PERMISSION_THREE_LEVELS = [
  "· 只读（read-only）：只能查看和提问，不能改文件、不能执行命令",
  "· 工作区读写（workspace-write，默认）：可在当前项目内读写文件、执行命令，碰不到项目外",
  "· 完全访问（danger-full-access）：无限制，可执行任何操作（高风险，慎用）",
] as const;
