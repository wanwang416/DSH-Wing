/**
 * M4.2 Web 面板改造 · panel 后端 route 单测
 *
 * createWingPanel 在 DSH Web 服务挂三个端点：
 *   GET  /plugins/dsh-wing/status → 桥状态 JSON（configured/appId masked/connState/计数/busy）
 *   GET  /plugins/dsh-wing/qr     → setup 中的二维码 PNG（无则 404）
 *   POST /plugins/dsh-wing/setup  → 触发后台扫码注册（Web 首次接通入口；busy 拒绝）
 */
import { describe, expect, it, vi } from "vitest";
import { createWingPanel, maskAppId } from "../../src/web/panel.js";
import type { WebServerLike } from "../../src/web/panel.js";

/** mock webServer：捕获注册的 routes，handler 收到 (req, res) 时写 head+end */
function mockWebServer() {
  const routes: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }[] = [];
  const server: WebServerLike = {
    register: (r) => {
      routes.push(r);
      return () => {};
    },
  };
  return { server, routes };
}

/** 构造 fake res（捕获 writeHead/end 参数） */
function fakeRes() {
  const calls: { status?: number; headers?: Record<string, string>; body?: unknown }[] = [];
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      calls.push({ status, headers });
    }),
    end: vi.fn((body?: unknown) => {
      calls.push({ body });
    }),
  };
  return { res, calls };
}

function makeDeps(overrides: Partial<Parameters<typeof createWingPanel>[0]> = {}) {
  const status = {
    get: () => ({
      connState: "connected",
      outboxPending: 0,
      outboxFailed: 0,
      inboundPending: 0,
      sessions: 2,
      wsReady: true,
      connectedAt: 1_750_000_000,
    }),
  };
  const setup = {
    start: vi.fn(async () => ({ url: "https://qr", expireIn: 600 })),
    getActiveQr: vi.fn(() => undefined),
    isBusy: vi.fn(() => false),
  };
  return {
    deps: { status, setup, resolveCredential: vi.fn(async () => ({ appId: "cli_abcdefgh1234" })), ...overrides },
    setup,
  };
}

describe("maskAppId", () => {
  it("短 id（≤8 位）→ ****", () => {
    expect(maskAppId("abcd1234")).toBe("****");
  });
  it("正常 id → 保留首6尾4", () => {
    expect(maskAppId("cli_abcdefghijkl5678")).toBe("cli_ab…5678");
  });
  it("undefined → undefined", () => {
    expect(maskAppId(undefined)).toBeUndefined();
  });
});

describe("createWingPanel routes", () => {
  it("注册三个 route：status / qr / setup", () => {
    const { server, routes } = mockWebServer();
    const { deps } = makeDeps();
    createWingPanel(deps).register(server);
    expect(routes.map((r) => r.path)).toEqual([
      "/plugins/dsh-wing/status",
      "/plugins/dsh-wing/qr",
      "/plugins/dsh-wing/setup",
    ]);
    expect(routes.every((r) => r.kind === "exact")).toBe(true);
  });

  it("GET status → JSON（configured=true, appId 打码, connState, busy）", async () => {
    const { server, routes } = mockWebServer();
    const { deps } = makeDeps();
    createWingPanel(deps).register(server);
    const { res, calls } = fakeRes();
    await routes[0].handler({}, res);
    expect(calls[0].status).toBe(200);
    expect(calls[0].headers?.["Content-Type"]).toContain("application/json");
    const body = JSON.parse(String(calls[1].body));
    expect(body).toMatchObject({
      configured: true,
      appId: "cli_ab…1234",
      connState: "connected",
      wsReady: true,
      outboxPending: 0,
      sessions: 2,
      busy: false,
    });
    expect(body.connectedAt).toBe(1_750_000_000);
  });

  it("GET status 未配置 → configured=false, appId=undefined", async () => {
    const { server, routes } = mockWebServer();
    const { deps } = makeDeps({ resolveCredential: vi.fn(async () => undefined) });
    createWingPanel(deps).register(server);
    const { res, calls } = fakeRes();
    await routes[0].handler({}, res);
    const body = JSON.parse(String(calls[1].body));
    expect(body.configured).toBe(false);
    expect(body.appId).toBeUndefined();
  });

  it("GET qr 有 activeQr → 200 PNG；无 → 404", async () => {
    // 有 QR
    {
      const { server, routes } = mockWebServer();
      const { deps, setup } = makeDeps();
      setup.getActiveQr.mockReturnValue({ png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]), expireAt: Date.now() + 60_000 });
      createWingPanel(deps).register(server);
      const { res, calls } = fakeRes();
      await routes[1].handler({}, res);
      expect(calls[0].status).toBe(200);
      expect(calls[0].headers?.["Content-Type"]).toBe("image/png");
      expect(Buffer.isBuffer(calls[1].body)).toBe(true);
    }
    // 无 QR
    {
      const { server, routes } = mockWebServer();
      const { deps } = makeDeps();
      createWingPanel(deps).register(server);
      const { res, calls } = fakeRes();
      await routes[1].handler({}, res);
      expect(calls[0].status).toBe(404);
    }
  });

  it("POST setup → ok:true 且后台 start(undefined)；busy → reason:busy；GET → 405", async () => {
    const { server, routes } = mockWebServer();
    const { deps, setup } = makeDeps();
    createWingPanel(deps).register(server);
    // POST → ok
    const { res, calls } = fakeRes();
    await routes[2].handler({ method: "POST" }, res);
    expect(calls[0].status).toBe(200);
    expect(JSON.parse(String(calls[1].body))).toEqual({ ok: true });
    expect(setup.start).toHaveBeenCalledWith(undefined);
    // busy → reason busy
    setup.isBusy.mockReturnValue(true);
    const { res: res2, calls: calls2 } = fakeRes();
    await routes[2].handler({ method: "POST" }, res2);
    expect(JSON.parse(String(calls2[1].body))).toEqual({ ok: false, reason: "busy" });
    expect(setup.start).toHaveBeenCalledTimes(1); // busy 时不重复触发
    // GET → 405
    const { res: res3, calls: calls3 } = fakeRes();
    await routes[2].handler({ method: "GET" }, res3);
    expect(calls3[0].status).toBe(405);
  });
});
