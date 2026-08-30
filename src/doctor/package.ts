/**
 * /doctor 诊断包生成（M4.2 任务 2：P0）
 *
 * 一键打包：插件日志（tail）+ 额外日志（SDK/session，存在才收）+ 脱敏配置 + 环境信息
 * + ISSUE.md 模板 + README.txt 说明 → ZIP，贴给 AI 即可定位问题。
 *
 * 铁律：配置强制脱敏（app_secret/token/bossOpenId 打码），日志不含完整聊天记录。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

/** 配置序列化（bossOpenId 半敏感，打码；其余字段无敏感信息） */
export function maskCfg(cfg: WingConfig): Record<string, unknown> {
  const out = { ...cfg } as Record<string, unknown>;
  if (typeof out.bossOpenId === "string") out.bossOpenId = mask(out.bossOpenId);
  return out;
}

/** 项目根：从插件自身文件位置向上找含 package.json 的最近目录。
 *  不依赖 process.cwd()——DSH 进程的工作目录是 D:\dsh，不是插件目录。 */
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

/** 读文件尾部 n 行；文件不存在/读失败返回 undefined（跳过收录） */
function tailLines(path: string, n: number): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return raw.split(/\r?\n/).slice(-n).join("\n");
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
