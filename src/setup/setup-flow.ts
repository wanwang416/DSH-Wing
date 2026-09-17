/**
 * /setup 扫码建应用 · 核心流程（M4.2，Web 面板改造后）
 *
 * 单一流程：后台注册（飞书官方 device-code）→ 二维码就绪 → 用户扫码 →
 * 拿到明文凭据 → persist → 重启桥。飞书 /setup 与 DSH Web 面板共用此流程，
 * 区别只在完成通知：有 chatId 发飞书通知，Web 触发（chatId=undefined）静默，
 * 面板轮询 status 即可看到「已连接」。
 *
 * activeQr 生命周期：onQRCodeReady 生成 PNG → 流程完成/失败清空；
 * /plugins/dsh-wing/qr route 通过 getActiveQr() 读取（配合 expireAt 判过期）。
 */
import { toPngBuffer } from "./qrcode.js";
import { startWecomQrLogin, pollWecomQrLogin, WECOM_POLL_INTERVAL_MS } from "./wecom-qr-auth.js";
import { createAuthSetup, registerAppWithFetch } from "./register-app.js";
import { buildSetupAddons } from "./addons.js";
import type { LarkCredential } from "../host/credentials.js";

export interface SetupFlowDeps {
  /** 写入凭据（index.ts 注入 credStore.set） */
  persist(result: LarkCredential): Promise<void>;
  /** 重启桥使新凭据生效（index.ts 注入 stopBridge + startBridge） */
  restart(): Promise<void>;
  /** 完成通知（仅 chatId 有值调用；Web 触发静默） */
  notify?(chatId: string, appId: string, domain: LarkCredential["domain"]): void;
  /** 失败通知（同上，仅 chatId 有值） */
  failNotify?(chatId: string, message: string): void;
  /** 企微扫码绑定流程的专属回调（index.ts 注入；缺省则企微流程不可用） */
  wecom?: { persist(result: { botId: string; secret: string }): Promise<void>; notify?(chatId: string): void; failNotify?(chatId: string, message: string): void; onStatus?(message: string): void };
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface SetupFlow {
  /**
   * 启动扫码流程（后台，非阻塞）。bounded wait 30s 返回二维码链接；
   * 流程进行中或超时返回 undefined。
   * @param chatId 飞书命令会话（有值 → 完成/失败通知）；Web 面板触发传 undefined
   */
  start(chatId?: string): Promise<{ url: string; expireIn: number } | undefined>;
  /** Web /qr route 读取：当前有效二维码 PNG（未过期）；无则 undefined */
  getActiveQr(): { png: Buffer; expireAt: number } | undefined;
  /** 流程是否进行中（防重复触发） */
  isBusy(): boolean;
  /** 启动企微扫码绑定流程（后台非阻塞；有界等待 30s 返回二维码链接） */
  startWecom(chatId?: string): Promise<{ url: string; expireIn: number } | undefined>;
  /** 企微扫码流程是否进行中（防重复触发） */
  isWecomBusy(): boolean;
}

const ABORTED = "Registration was aborted";

export function createSetupFlow(deps: SetupFlowDeps): SetupFlow {
  let inflight = false;
  let wecomInflight = false; // 企微扫码流程进行中（防重）
  let epoch = 0; // 流程代数：每次 start 递增；完成/失败再递增，使挂起的 toPngBuffer 写入失效
  let activeQr: { png: Buffer; expireAt: number } | undefined;

  return {
    isBusy: () => inflight,
    getActiveQr: () => (activeQr && Date.now() < activeQr.expireAt ? activeQr : undefined),

    async start(chatId) {
      if (inflight) return undefined; // 防重：上次流程未结束
      inflight = true;
      activeQr = undefined;
      const myEpoch = ++epoch;
      let qrInfo: { url: string; expireIn: number } | undefined;
      const ac = new AbortController();

      void (async () => {
        const setup = createAuthSetup({
          registerApp: registerAppWithFetch(),
          persist: deps.persist,
          addons: buildSetupAddons(),
          logger: deps.logger,
        });
        try {
          const res = await setup.run({
            onQRCodeReady: (info) => {
              qrInfo = info;
              // 生成 PNG 供 Web 面板 <img> 展示（异步，失败不阻塞流程）。
              // epoch 检查：流程可能先完成（activeQr 已清空），挂起的写入不得复活旧二维码
              void toPngBuffer(info.url).then((png) => {
                if (png && myEpoch === epoch) activeQr = { png, expireAt: Date.now() + info.expireIn * 1000 };
              });
            },
            onStatusChange: (s) => deps.logger?.info?.(`setup: ${s}`),
            signal: ac.signal,
          });
          deps.logger?.info?.(`setup complete: appId=${res.appId} domain=${res.domain}`);
          await deps.persist(res);
          await deps.restart();
          epoch++;
          activeQr = undefined;
          if (chatId) deps.notify?.(chatId, res.appId, res.domain);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          epoch++;
          activeQr = undefined;
          if (message !== ABORTED) {
            deps.logger?.warn?.(`setup background failed: ${message}`);
            if (chatId) deps.failNotify?.(chatId, message);
          }
        } finally {
          inflight = false;
        }
      })();

      // 有界等待二维码就绪（begin 请求到 accounts.feishu.cn，一般 <2s）
      const deadline = Date.now() + 30_000;
      while (!qrInfo && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!qrInfo) {
        ac.abort(); // 超时 → 取消后台注册，释放防重锁
        return undefined;
      }
      return qrInfo;
    },

    async startWecom(chatId) {
      if (wecomInflight) return undefined; // 防重
      wecomInflight = true;
      let info: { url: string; expireIn: number } | undefined;
      void (async () => {
        try {
          const start = await startWecomQrLogin({});
          deps.wecom?.onStatus?.(`企微二维码已生成，请在 ${Math.round((start.expiresAt - Date.now()) / 1000)} 秒内扫码`);
          info = { url: start.verificationUrl, expireIn: Math.round((start.expiresAt - Date.now()) / 1000) };
          const deadline = start.expiresAt;
          for (;;) {
            if (Date.now() > deadline) {
              deps.wecom?.failNotify?.(chatId ?? "", "二维码已过期，请重新发起 /setup wecom。");
              break;
            }
            await new Promise((r) => setTimeout(r, WECOM_POLL_INTERVAL_MS));
            const res = await pollWecomQrLogin({ sessionKey: start.sessionKey });
            if (res.connected) {
              await deps.wecom?.persist({ botId: res.botId, secret: res.secret });
              await deps.restart();
              deps.wecom?.notify?.(chatId ?? "");
              break;
            }
            if (res.status === "waiting") continue;
            deps.wecom?.failNotify?.(chatId ?? "", res.message);
            break;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.wecom?.failNotify?.(chatId ?? "", `企微扫码绑定失败：${message}`);
        } finally {
          wecomInflight = false;
        }
      })();
      // 有界等待二维码就绪（generate 请求一般 <2s）
      const deadline = Date.now() + 30_000;
      while (!info && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return info;
    },
    isWecomBusy: () => wecomInflight,
  };
}
