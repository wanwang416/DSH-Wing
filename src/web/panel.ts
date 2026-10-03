/**
 * DSH Web 面板 · 后端 route（M4.2 Web 扫码改造）
 *
 * 对照 dsh-lark-link：在 DSH Web 服务挂三个端点，供 Web 前端面板拉取——
 *   GET  /plugins/dsh-wing/status  → 桥状态 JSON（configured / connState / 计数）
 *   GET  /plugins/dsh-wing/qr      → 扫码 PNG（setup 流程进行中才有效，否则 404）
 *   POST /plugins/dsh-wing/setup   → 触发后台扫码注册（Web 首次接通入口）
 *
 * 前端面板（src/client）注册到 Web 侧栏，轮询这些端点实时展示。
 */

/** DSH host webServer.register 的最小结构（类型强转，host 提供但未声明类型） */
export interface WebServerLike {
  register(r: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: unknown, res: unknown) => void;
  }): () => void;
}

interface ResLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: unknown): unknown;
}

interface ReqLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * ★ G13（阶段5c）：面板访问来源校验（CSRF / 跨站钉死）。
 * 策略（不破坏 DSH GUI 与本机使用）：
 *   - 无 Origin 且无 Referer（curl / GUI 内部请求 / 同源导航的常见形态）→ 放行；
 *   - 带 Origin 或 Referer 时：host 必须是本机回环（127.0.0.1 / localhost / [::1]）→ 放行；
 *   - 其余（任何非回环来源，含跨站 evil 域名）→ 拒绝（403）+ warn 留痕。
 * 不加 token 强校验：/status 等只读接口是 GUI 轮询依赖，token 会破坏现有访问。
 */
export function isAllowedOrigin(headers: Record<string, string | string[] | undefined> | undefined): boolean {
  if (!headers) return true;
  const pick = (k: string): string | undefined => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const origin = pick("origin");
  const referer = pick("referer");
  if (!origin && !referer) return true; // 无来源头 = 非浏览器 / 同源直连 → 放行
  const isLoopback = (u: string): boolean => {
    try {
      const h = new URL(u).hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    } catch {
      return false;
    }
  };
  if (origin && !isLoopback(origin)) return false;
  if (!origin && referer && !isLoopback(referer)) return false;
  return true;
}

/** 来源被拒的统一收口：403 + warn 留痕（不许静默 200，铁律 3） */
function rejectOrigin(res: ResLike, path: string, logger?: { warn?(m: string): void }): void {
  logger?.warn?.(`web panel：来源校验拒绝（跨站来源访问 ${path}）→ 403`);
  res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: false, reason: "origin not allowed（仅限本机回环来源访问）" }));
}

export interface WingPanelDeps {
  /** 桥状态（status.get()） */
  status: { get(): { connState: string; outboxPending: number; outboxFailed: number; inboundPending: number; sessions: number; wsReady: boolean; connectedAt?: number; wecomConnState?: "disconnected" | "connected" | null; wecomReady?: boolean | null } };
  /** 凭据解析（判断是否已配置） */
  resolveCredential(): Promise<{ appId?: string } | undefined>;
  /** setup 核心流程（start / getActiveQr / isBusy） */
  setup: {
    start(chatId?: string): Promise<{ url: string; expireIn: number } | undefined>;
    getActiveQr(): { png: Buffer; expireAt: number } | undefined;
    isBusy(): boolean;
  };
  /** 企微扫码流程（M2：面板通道；N6：hasCredential 防误扫重绑） */
  wecomSetup: {
    start(): Promise<{ url: string; expireIn: number } | undefined>;
    getQr(): { png: Buffer; expireAt: number } | undefined;
    isBusy(): boolean;
    hasCredential(): Promise<boolean>;
  };
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

/** appId 打码（保留首尾，中段隐藏） */
export function maskAppId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id.length <= 8) return "****";
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** 组装面板后端；返回 register(webServer) 挂载函数 */
export function createWingPanel(deps: WingPanelDeps) {
  return {
    register(webServer: WebServerLike): void {
      deps.logger?.info?.("web panel: /plugins/dsh-wing/{status,qr,setup} routes ready");
      // GET status
      webServer.register({
        kind: "exact",
        path: "/plugins/dsh-wing/status",
        handler: async (_req, res) => {
          const r = res as ResLike;
          const q = _req as ReqLike;
          if (!isAllowedOrigin(q.headers)) return rejectOrigin(r, "/status", deps.logger);
          const cred = await deps.resolveCredential();
          const st = deps.status.get();
          r.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          r.end(
            JSON.stringify({
              configured: Boolean(cred?.appId),
              appId: maskAppId(cred?.appId),
              connState: st.connState,
              wsReady: st.wsReady,
              wecomConnState: st.wecomConnState ?? null,
              wecomReady: st.wecomReady ?? null,
              outboxPending: st.outboxPending,
              outboxFailed: st.outboxFailed,
              inboundPending: st.inboundPending,
              sessions: st.sessions,
              connectedAt: st.connectedAt ?? null,
              busy: deps.setup.isBusy(),
            }),
          );
        },
      });

      // GET qr（setup 流程中的二维码 PNG）
      webServer.register({
        kind: "exact",
        path: "/plugins/dsh-wing/qr",
        handler: (_req, res) => {
          const r = res as ResLike;
          if (!isAllowedOrigin((_req as ReqLike).headers)) return rejectOrigin(r, "/qr", deps.logger);
          const qr = deps.setup.getActiveQr();
          if (qr) {
            r.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            r.end(qr.png);
          } else {
            r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            r.end("no active dsh-wing setup qr (run /setup or click 扫码连接 in the panel)");
          }
        },
      });

      // POST setup（Web 触发扫码注册；无 chatId → 静默完成）
      webServer.register({
        kind: "exact",
        path: "/plugins/dsh-wing/setup",
        handler: (req, res) => {
          const r = res as ResLike;
          if (!isAllowedOrigin((req as ReqLike).headers)) return rejectOrigin(r, "/setup", deps.logger);
          const { method = "" } = req as ReqLike;
          if (method.toUpperCase() !== "POST") {
            r.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
            r.end(JSON.stringify({ ok: false, reason: "method not allowed" }));
            return;
          }
          if (deps.setup.isBusy()) {
            r.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            r.end(JSON.stringify({ ok: false, reason: "busy" }));
            return;
          }
          deps.logger?.info?.("web panel: 触发 /setup");
          void deps.setup.start(undefined); // 后台注册，QR 经 /qr 供面板轮询
          r.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          r.end(JSON.stringify({ ok: true }));
        },
      });

      // POST wecom/setup（M2：Web 触发企微扫码注册；无 chatId → 静默完成）
      webServer.register({
        kind: "exact",
        path: "/plugins/dsh-wing/wecom/setup",
        handler: (req, res) => {
          const r = res as ResLike;
          if (!isAllowedOrigin((req as ReqLike).headers)) return rejectOrigin(r, "/wecom/setup", deps.logger);
          const { method = "" } = req as ReqLike;
          if (method.toUpperCase() !== "POST") {
            r.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
            r.end(JSON.stringify({ ok: false, reason: "method not allowed" }));
            return;
          }
          if (deps.wecomSetup.isBusy()) {
            r.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            r.end(JSON.stringify({ ok: false, reason: "busy" }));
            return;
          }
          deps.logger?.info?.("web panel: 触发 /wecom/setup");
          void deps.wecomSetup.start(); // 后台注册，QR 经 /wecom/qr 读取
          r.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          r.end(JSON.stringify({ ok: true }));
        },
      });

      // GET wecom/qr（M2/N4/N6 + ★G13 阶段5c）：当前企微二维码 PNG——GET 收敛为**纯只读**：
      //   有活跃二维码 → 返回 PNG；无二维码 → 不再自动发起（原 L186-192 GET 副作用移除，防跨站/预取触发扫码），
      //   统一 409/202 提示走 POST /wecom/setup。已绑定且无流程 → 409 防误扫重绑（N6 保留）
      webServer.register({
        kind: "exact",
        path: "/plugins/dsh-wing/wecom/qr",
        handler: async (req, res) => {
          const r = res as ResLike;
          if (!isAllowedOrigin((req as ReqLike).headers)) return rejectOrigin(r, "/wecom/qr", deps.logger);
          const { url = "" } = req as ReqLike;
          const qr = deps.wecomSetup.getQr();
          if (qr) {
            r.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            r.end(qr.png);
            return;
          }
          const force = url.includes("force=1");
          if (!force && (await deps.wecomSetup.hasCredential()) && !deps.wecomSetup.isBusy()) {
            // N6：已绑定且无活跃流程 → 409，防误扫重绑
            r.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            r.end(JSON.stringify({ ok: false, reason: "企微机器人已绑定；如需重新绑定请用 ?force=1 或先清除 WING_WECOM_BOT 凭据" }));
            return;
          }
          // ★ G13：GET 不再自动发起扫码（副作用只留 POST /wecom/setup）；提示客户端改走 POST
          r.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          r.end(JSON.stringify({ ok: false, reason: "暂无活跃二维码。请 POST /plugins/dsh-wing/wecom/setup 发起扫码（GET 不再自动发起）" }));
        },
      });
    },
  };
}
