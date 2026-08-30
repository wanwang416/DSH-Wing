/**
 * /setup 扫码建应用 · 飞书应用注册 device-code 流程（M4.2）
 *
 * 移植自 dsh-lark-link auth-setup.ts（MIT）：
 * 直接调飞书官方应用注册端点 accounts.feishu.cn/oauth/v1/app/registration
 * （RFC 8628 device-code flow），扫码授权后 poll 返回明文 client_id/client_secret。
 *
 * 不依赖 lark-cli——绕开其「secret 锁 keychain 不外传」的约束，全自动拿密钥。
 * SDK 自带 registerApp 的 axios 在 Node ESM 下有坑，故用全局 fetch 复刻 wire 协议。
 */
import { gzipSync } from "node:zlib";
import { buildSetupAddons, type SetupAddons } from "./addons.js";
import type { LarkCredential } from "../host/credentials.js";

export type LarkDomain = LarkCredential["domain"];

/** 扫码授权链接信息（onQRCodeReady 回调载荷） */
export interface QRCodeInfo {
  url: string;
  expireIn: number;
}

/** 扫码创建应用的最终结果（appId + 明文 appSecret + 检测的域名） */
export type SetupResult = LarkCredential;

/** 最小结构类型（对齐 SDK registerApp 签名；测试注入用） */
export type RegisterAppFn = (options: {
  source?: string;
  addons?: SetupAddons;
  appId?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: QRCodeInfo) => void;
  onStatusChange?: (info: { status?: string }) => void;
}) => Promise<{
  client_id?: string;
  client_secret?: string;
  user_info?: { tenant_brand?: string };
}>;

/** Lark（国际版）vs Feishu（国内版）域名识别 */
export function detectDomain(userInfo: { tenant_brand?: string } | undefined): LarkDomain {
  return userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
}

/** base64url(gzip(addons))——对齐 SDK encodeAddons 编码 */
export function encodeAddons(addons: SetupAddons): string {
  const json = JSON.stringify(addons);
  return gzipSync(Buffer.from(json, "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function postForm(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "dsh-wing (device-code client)",
      },
      body: new URLSearchParams(params).toString(),
      signal,
    });
  } catch (err) {
    throw new Error(`registration request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  // device-code 流程错误经 HTTP 400 body 报告——surface 它们，而非当传输失败
  if (!res.ok && !data.error) {
    throw new Error(`registration request failed: HTTP ${res.status}`);
  }
  return data;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Registration was aborted"));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Registration was aborted"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * registerApp 的 fetch 实现。wire 协议对齐 @larksuiteoapi/node-sdk registerApp
 * （对 accounts.feishu.cn / accounts.larksuite.com 的 device-code 流程），
 * 二维码与创建应用载荷与 SDK 路径字节兼容。
 */
export function registerAppWithFetch(): RegisterAppFn {
  return async (options) => {
    const { source, signal, onQRCodeReady, onStatusChange, addons } = options;
    const baseUrl = "https://accounts.feishu.cn";
    const larkBaseUrl = "https://accounts.larksuite.com";
    const endpoint = "/oauth/v1/app/registration";

    const beginRes = await postForm(
      baseUrl + endpoint,
      {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      },
      signal,
    );
    const verificationUri = beginRes.verification_uri_complete;
    if (typeof verificationUri !== "string" || verificationUri === "") {
      throw new Error(
        (beginRes.error_description as string) ?? "registerApp begin 未返回 verification_uri_complete",
      );
    }
    let qrUrl: URL;
    try {
      qrUrl = new URL(verificationUri);
    } catch {
      throw new Error(
        `registerApp begin 返回了无效的 verification_uri_complete: ${verificationUri.slice(0, 80)}`,
      );
    }
    qrUrl.searchParams.set("from", "sdk");
    qrUrl.searchParams.set("source", `node-sdk/${source ?? "dsh-wing"}`);
    qrUrl.searchParams.set("tp", "sdk");
    if (addons) qrUrl.searchParams.set("addons", encodeAddons(addons));

    onQRCodeReady({
      url: qrUrl.toString(),
      expireIn: (beginRes.expires_in as number | undefined) ?? 600,
    });

    // 轮询扫码状态（RFC 8628 device-code flow）
    const deviceCode = beginRes.device_code as string | undefined;
    if (!deviceCode) throw new Error("registerApp begin 未返回 device_code");
    let currentBase = baseUrl;
    let interval = ((beginRes.interval as number | undefined) ?? 5) * 1000;
    const deadline = Date.now() + ((beginRes.expires_in as number | undefined) ?? 600) * 1000;
    let domainSwitched = false;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Registration was aborted");
      const pollRes = await postForm(currentBase + endpoint, { action: "poll", device_code: deviceCode }, signal);
      const userInfo = pollRes.user_info as { tenant_brand?: string } | undefined;
      // Lark 域名切换（仅一次）
      if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
        currentBase = larkBaseUrl;
        domainSwitched = true;
        onStatusChange?.({ status: "domain_switched" });
        continue;
      }
      const clientId = pollRes.client_id as string | undefined;
      const clientSecret = pollRes.client_secret as string | undefined;
      if (clientId && clientSecret) {
        return { client_id: clientId, client_secret: clientSecret, user_info: userInfo };
      }
      switch (pollRes.error) {
        case "authorization_pending":
          onStatusChange?.({ status: "polling" });
          break;
        case "slow_down":
          interval += 5000;
          onStatusChange?.({ status: "slow_down", interval: interval / 1000 } as unknown as { status?: string });
          break;
        case "access_denied":
        case "expired_token":
          throw new Error(
            (pollRes.error_description as string | undefined) ?? `注册失败：${String(pollRes.error)}`,
          );
        default:
          if (pollRes.error) {
            throw new Error(
              (pollRes.error_description as string | undefined) ?? `注册失败：${String(pollRes.error)}`,
            );
          }
          break;
      }
      await sleep(interval, signal);
    }
    throw new Error("注册轮询超时（二维码已过期），请重新运行 /setup");
  };
}

/** 纯流程编排：注册 → 扫码 → 返回明文凭据（可注入 persist，便于测试） */
export interface AuthSetupDeps {
  registerApp: RegisterAppFn;
  persist(result: SetupResult): Promise<void>;
  /** 创建应用时应用的权限/事件配置（默认 buildSetupAddons()） */
  addons?: SetupAddons;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface AuthSetup {
  run(opts: {
    onQRCodeReady(info: QRCodeInfo): void;
    onStatusChange?(status: string): void;
    /** 调用方可在超时/取消时 abort 注册流程（registerApp begin/poll/sleep 均响应） */
    signal?: AbortSignal;
  }): Promise<SetupResult>;
}

export function createAuthSetup(deps: AuthSetupDeps): AuthSetup {
  return {
    async run(opts) {
      opts.onStatusChange?.("创建应用中…");
      const created = await deps.registerApp({
        source: "dsh-wing",
        addons: deps.addons ?? buildSetupAddons(),
        onQRCodeReady: (info) => opts.onQRCodeReady(info),
        onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…"),
        signal: opts.signal,
      });
      const appId = created.client_id ?? "";
      const appSecret = created.client_secret ?? "";
      if (!appId || !appSecret) {
        throw new Error("registerApp 未返回 client_id/client_secret");
      }
      const domain = detectDomain(created.user_info);
      await deps.persist({ appId, appSecret, domain });
      opts.onStatusChange?.("完成 ✅");
      return { appId, appSecret, domain };
    },
  };
}
