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
}

const ABORTED = "Registration was aborted";

export function createSetupFlow(deps: SetupFlowDeps): SetupFlow {
  let inflight = false;
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
  };
}
