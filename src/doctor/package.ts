/**
 * /doctor 诊断包生成（M4.2 任务 2：P0）
 *
 * 一键打包：插件日志（tail）+ 额外日志（SDK/session，存在才收）+ 脱敏配置 + 环境信息
 * + ISSUE.md 模板 + README.txt 说明 → ZIP，贴给 AI 即可定位问题。
 *
 * 铁律：配置强制脱敏（app_secret/token/bossOpenId 打码），日志不含完整聊天记录。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { WingConfig } from "../config/defaults.js";
import type { LarkCredential } from "../host/credentials.js";

export interface DoctorPackageOpts {
  /** 插件状态目录（stateDir()：dsh-wing.log 所在目录，ZIP 也写这里） */
  stateDir: string;
  /** 运行配置（序列化进 config.json；bossOpenId 打码） */
  cfg: WingConfig;
  /** 已 resolve 的飞书凭据（可选；appSecret 全打码、appId 打码首尾） */
  credential?: LarkCredential;
  /** 插件版本号 */
  pluginVersion: string;
  /** 额外日志路径（如 SDK 日志 / session 日志），存在才收录 */
  extraLogPaths?: string[];
  /** 每份日志保留尾部行数（默认 500） */
  logTailLines?: number;
  /** 测试注入时间点 */
  now?: Date;
}

export interface DoctorPackageResult {
  zipPath: string;
  /** ZIP 字节数 */
  size: number;
  /** ZIP 内条目（调试/测试用） */
  entries: string[];
}

/** 打码：保留前 keep 位，其余星号；过短直接 *** */
export function mask(s: string | undefined, keep = 4): string {
  if (!s) return "***";
  return s.length > keep ? `${s.slice(0, keep)}${"*".repeat(6)}` : "***";
}

/** 凭据脱敏快照（appSecret 全打码、appId 打码首尾、domain 保留） */
export function maskCredential(c: LarkCredential): Record<string, string> {
  return { appId: mask(c.appId), appSecret: "***", domain: c.domain };
}

/**
 * 配置序列化脱敏（★ G11 阶段5c 重写：逐字段过 WingConfig，判断标准 = 泄露后能否冒充机器人/ALAN）。
 * 敏感项：
 *   - wecom.secret        → 企微机器人 AppSecret，泄露 = 冒充机器人 → 全打码
 *   - bossOpenId          → 老板身份，泄露 = 可伪造审批语境 → 半打码
 *   - wecomBossUserId     → 企微老板身份（审批/提权校验依据）→ 半打码
 *   - credentialRef       → 凭据引用名（非值本身），保留——凭据值在 DSH credential store，不进 cfg
 * 其余字段（streaming/permissionMode/groupPolicy/reactions/turnTimeoutMs/agentPreset 等）
 * 均为行为配置，泄露无冒充风险 → 保留（agent 排障仍可读）。
 */
export function maskCfg(cfg: WingConfig): Record<string, unknown> {
  const out = { ...cfg } as Record<string, unknown>;
  if (typeof out.bossOpenId === "string") out.bossOpenId = mask(out.bossOpenId);
  if (typeof out.wecomBossUserId === "string") out.wecomBossUserId = mask(out.wecomBossUserId);
  if (out.wecom && typeof out.wecom === "object") {
    out.wecom = { ...(out.wecom as Record<string, unknown>) };
    const w = out.wecom as Record<string, unknown>;
    if (typeof w.secret === "string") w.secret = "***";
  }
  return out;
}

/** 项目根：从插件自身文件位置向上找含 package.json 的最近目录。
 *  不依赖 process.cwd()——DSH 进程的工作目录是 D:/DSH_HOME，不是插件目录。 */
function projectRoot(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "package.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    /* fallthrough */
  }
  return undefined;
}

/** 读 package.json 的 version；文件缺失/解析失败返回 unknown */
function readVersion(p: string): string {
  try {
    if (!existsSync(p)) return "unknown";
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 插件自身版本（读项目根 package.json） */
export function pluginVersion(): string {
  const root = projectRoot();
  return root ? readVersion(join(root, "package.json")) : "unknown";
}

/** 读文件尾部 n 行；文件不存在/读失败返回 undefined（跳过收录）。
 *  ★ M37（阶段5c）：不再全量 readFileSync（日志可达 180MB 级）——按 n 行 × 估计行长（256B/行，下限 64KB）
 *  只读尾部窗口（O(1) 内存），窗口切行取最后 n 行；若窗口首行非文件起点且首行不是完整行，
 *  丢弃半行（宁少一行不串内容）。全仓调用点（插件日志/宿主日志/sdk-debug）统一受益。 */
export function tailLines(path: string, n: number): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const size = statSync(path).size;
    const windowBytes = Math.min(size, Math.max(64 * 1024, n * 256));
    const start = size - windowBytes;
    let raw: string;
    if (start <= 0) {
      raw = readFileSync(path, "utf8");
    } else {
      const buf = Buffer.alloc(windowBytes);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, windowBytes, start);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString("utf8");
      // 窗口起点在行中间 → 丢弃首个不完整行（除非 start 恰在行首——无法低成本判断，统一丢弃首段到首个换行）
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }
    const lines = raw.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop(); // 结尾换行产生的空尾段
    return lines.slice(-n).join("\n");
  } catch {
    return undefined;
  }
}

/** 从项目根 node_modules 读依赖包版本；失败返回 unknown */
function pkgVersion(name: string): string {
  const root = projectRoot();
  return root ? readVersion(join(root, "node_modules", name, "package.json")) : "unknown";
}

export function envInfo(opts: DoctorPackageOpts): Record<string, string> {
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    dshWing: opts.pluginVersion,
    dshAgent: pkgVersion("@deepseek-ai/dsh-agent"),
    dshCommands: pkgVersion("@deepseek-ai/dsh-commands"),
    larkSdk: pkgVersion("@larksuiteoapi/node-sdk"),
    stateDir: opts.stateDir,
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

const ISSUE_TEMPLATE = (env: Record<string, string>): string => `# 问题描述
请填写你遇到的问题（必填）：

- 操作步骤：
- 期望行为：
- 实际行为：
- 相关截图 / 错误信息：

## 环境信息（自动生成）
${Object.entries(env)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

## 使用说明
本 ZIP 含插件日志（最近若干行）、脱敏配置、环境信息。请连同本文件一起交给 AI 助手或附在 issue 中。
敏感信息（app_secret / token）已在配置中打码为 ***。
`;

const README_TXT = `DSH-Wing 诊断包 · 使用说明
================================
1. 把本 ZIP 发送给 AI 助手（如黑仔 / 哈马），或附在你的 issue / bug report 里。
2. 配置文件 config.json 中的敏感字段已脱敏（app_secret / token 显示为 ***），可放心分享。
3. 日志仅收录最近若干行，不含完整聊天记录。
4. 如日志或配置文件缺失，说明对应功能未启用或路径不同，可在 ISSUE.md 里补充说明。
`;

/** 生成诊断包 ZIP，写入 <stateDir>/doctor-<ts>.zip */
export async function createDoctorPackage(opts: DoctorPackageOpts): Promise<DoctorPackageResult> {
  const tail = opts.logTailLines ?? 500;
  const zip = new JSZip();
  const entries: string[] = [];

  // 1. 插件日志（dsh-wing.log）
  const pluginLog = tailLines(join(opts.stateDir, "dsh-wing.log"), tail);
  if (pluginLog !== undefined) {
    zip.file("dsh-wing.log", pluginLog);
    entries.push("dsh-wing.log");
  }

  // 2. 额外日志（SDK / session / subagent，存在才收）
  for (const p of opts.extraLogPaths ?? []) {
    const l = tailLines(p, tail);
    if (l !== undefined) {
      zip.file(basename(p), l);
      entries.push(basename(p));
    }
  }

  // 3. 脱敏配置（cfg + 凭据快照）
  const configJson = opts.credential
    ? { ...maskCfg(opts.cfg), credential: maskCredential(opts.credential) }
    : maskCfg(opts.cfg);
  zip.file("config.json", JSON.stringify(configJson, null, 2));
  entries.push("config.json");

  // 4. 环境信息 + ISSUE/README 模板
  const env = envInfo(opts);
  zip.file("ISSUE.md", ISSUE_TEMPLATE(env));
  entries.push("ISSUE.md");
  zip.file("README.txt", README_TXT);
  entries.push("README.txt");

  // 5. 写 ZIP 到 stateDir
  const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  mkdirSync(opts.stateDir, { recursive: true });
  const zipPath = join(opts.stateDir, `doctor-${ts}.zip`);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(zipPath, buf);
  return { zipPath, size: buf.byteLength, entries };
}
