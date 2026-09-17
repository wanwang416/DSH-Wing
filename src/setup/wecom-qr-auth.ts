/**
 * 企业微信智能机器人 · 扫码创建/绑定（长连接模式的凭证获取）。
 *
 * 流程（参考 cc-haha 2026-09-16 落地，D:\ACC\cc-haha-src\adapters\wecom\qr-auth.ts）：
 *   GET https://work.weixin.qq.com/ai/qc/generate?source=dsh-wing&plat=2
 *     → { data: { scode, auth_url } }，auth_url 转二维码给用户扫
 *   用户用企业微信 App 扫码 → 自动创建并授权智能机器人
 *   轮询 GET https://work.weixin.qq.com/ai/qc/query_result?scode=xxx
 *     → status=success 时 { data: { bot_info: { botid, secret } } }
 *   botid + secret 即 WebSocket 长连接所需的全部凭证。
 *
 * 与哈马实现的有意差异：
 *   1) source 用 'dsh-wing'（哈马用 'claude-code-haha'），避免绑定冲突；
 *   2) 扫码失败/不可用时，走「手动填 BotID/Secret」兜底（cordis.patch.yml 或环境变量）。
 * 安全：auth_url 仅允许 work.weixin.qq.com 的 https 原址转码，其余一律失败关闭。
 */

import { randomBytes } from "node:crypto";

const GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const POLL_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const REQUEST_TIMEOUT_MS = 10_000;
/** 企微控制台生成的扫码码 5 分钟后失效 */
const QR_TTL_MS = 5 * 60_000;
export const WECOM_POLL_INTERVAL_MS = 3_000;

/** 绑定来源标识：企微按 source 区分绑定到哪个服务，务必与哈马/其他 Agent 隔离 */
const DEFAULT_SOURCE = "dsh-wing";

/** 运行平台码：1=mac/其他 2=windows 3=linux（对齐企微扫码接口约定） */
function currentPlatformCode(platform: NodeJS.Platform = process.platform): 1 | 2 | 3 {
  if (platform === "win32") return 2;
  if (platform === "linux") return 3;
  return 1;
}

interface WecomLoginSession {
  sessionKey: string;
  scode: string;
  verificationUrl: string;
  startedAt: number;
}

const activeLogins = new Map<string, WecomLoginSession>();

export interface WecomQrStartResult {
  sessionKey: string;
  verificationUrl: string;
  expiresAt: number;
  pollIntervalMs: number;
  message: string;
}

export type WecomQrPollResult =
  | { connected: true; botId: string; secret: string }
  | { connected: false; status: "waiting" | "expired" | "failed" | "not_started"; message: string };

function isFresh(session: WecomLoginSession): boolean {
  return Date.now() - session.startedAt < QR_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [key, session] of activeLogins) {
    if (!isFresh(session)) activeLogins.delete(key);
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 仅允许企微控制台自身 HTTPS 原址转成二维码，其余一律拒绝 */
function safeVerificationUrl(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const safeHost = url.hostname === "work.weixin.qq.com";
    const safePort = !url.port || url.port === "443";
    if (url.protocol !== "https:" || !safeHost || !safePort) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function requestJson(url: URL, fetchImpl: typeof fetch): Promise<Record<string, any>> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`企业微信扫码服务返回 HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("企业微信扫码服务返回非 JSON 内容");
  }
  return body as Record<string, any>;
}

/**
 * 发起一次扫码绑定流程：获取 scode + auth_url（转二维码）。
 * 已存在且未过期的同 sessionKey 流程会复用（force 强制重开）。
 */
export async function startWecomQrLogin(
  opts: { force?: boolean; sessionKey?: string; source?: string; fetchImpl?: typeof fetch } = {},
): Promise<WecomQrStartResult> {
  purgeExpiredLogins();

  const sessionKey = opts.sessionKey || randomBytes(16).toString("hex");
  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isFresh(existing)) {
    return {
      sessionKey,
      verificationUrl: existing.verificationUrl,
      expiresAt: existing.startedAt + QR_TTL_MS,
      pollIntervalMs: WECOM_POLL_INTERVAL_MS,
      message: "二维码已就绪，请使用企业微信扫描。",
    };
  }

  const url = new URL(GENERATE_URL);
  url.searchParams.set("source", opts.source || DEFAULT_SOURCE);
  url.searchParams.set("plat", String(currentPlatformCode()));

  const body = await requestJson(url, opts.fetchImpl ?? fetch);
  const scode = cleanString(body?.data?.scode);
  const verificationUrl = safeVerificationUrl(body?.data?.auth_url);
  if (!scode || !verificationUrl) {
    throw new Error("企业微信扫码服务返回数据无效");
  }

  const startedAt = Date.now();
  activeLogins.set(sessionKey, { sessionKey, scode, verificationUrl, startedAt });

  return {
    sessionKey,
    verificationUrl,
    expiresAt: startedAt + QR_TTL_MS,
    pollIntervalMs: WECOM_POLL_INTERVAL_MS,
    message: "使用企业微信扫描二维码，创建并授权智能机器人。",
  };
}

/**
 * 轮询扫码结果：success → 返回 botId + secret；其余返回等待/过期/失败状态。
 */
export async function pollWecomQrLogin(
  opts: { sessionKey: string; fetchImpl?: typeof fetch },
): Promise<WecomQrPollResult> {
  purgeExpiredLogins();

  const session = activeLogins.get(opts.sessionKey);
  if (!session) {
    return {
      connected: false,
      status: "not_started",
      message: "当前没有进行中的企业微信绑定，请重新生成二维码。",
    };
  }

  const url = new URL(POLL_URL);
  url.searchParams.set("scode", session.scode);
  const body = await requestJson(url, opts.fetchImpl ?? fetch);
  const status = cleanString(body?.data?.status)?.toLowerCase();

  if (status === "success") {
    const botId = cleanString(body?.data?.bot_info?.botid);
    const secret = cleanString(body?.data?.bot_info?.secret);
    if (!botId || !secret) {
      activeLogins.delete(opts.sessionKey);
      return {
        connected: false,
        status: "failed",
        message: "企业微信返回的机器人凭据不完整，请重新扫码。",
      };
    }
    activeLogins.delete(opts.sessionKey);
    return { connected: true, botId, secret };
  }

  if (status === "expired" || status === "timeout") {
    activeLogins.delete(opts.sessionKey);
    return { connected: false, status: "expired", message: "二维码已过期，请重新生成。" };
  }

  if (status === "fail" || status === "failed" || status === "error") {
    activeLogins.delete(opts.sessionKey);
    return { connected: false, status: "failed", message: "企业微信授权失败，请重新扫码。" };
  }

  return { connected: false, status: "waiting", message: "等待企业微信扫码确认..." };
}

/** 丢弃进行中的扫码流程（用户取消或重绑） */
export function cancelWecomQrLogin(sessionKey: string): void {
  activeLogins.delete(sessionKey);
}

/** 测试隔离：模块级 session 表不得跨用例泄漏 */
export function resetWecomQrLoginsForTest(): void {
  activeLogins.clear();
}
