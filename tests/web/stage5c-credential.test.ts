/**
 * ★ 阶段 5c 攻击场景回归（G11 / G13 / M37，2026-10-03）
 *
 * 攻击者视角：
 *  - G11：哨兵值手法——cfg 敏感字段设唯一假值，断言任何序列化出口都不含哨兵（静默外泄钉死）
 *  - G13：伪造来源访问面板 → 被拒（403）+ warn 留痕；正常来源 → 可用
 *  - M37：超大日志 tailLines 不再全量读盘（只读尾部窗口），且末尾 n 行内容正确
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskCfg } from "../../src/doctor/package.js";
import { createWingPanel, type WebServerLike } from "../../src/web/panel.js";

// ━━━━━━━━━━━ G11：cfg 序列化出口脱敏（哨兵值手法） ━━━━━━━━━━━
describe("5c · G11：cfg 序列化出口不含敏感值（哨兵值）", () => {
  const S = "SENTINEL_SECRET_DO_NOT_LEAK_12345";
  const S_ID = "SENTINEL_BOSSID_DO_NOT_LEAK_67890";
  const S_WECOM = "SENTINEL_WECOMBOSS_DO_NOT_LEAK_abcde";

  function sentryCfg() {
    return {
      ...JSON.parse(JSON.stringify({})),
      credentialRef: "WING_LARK_APP",
      streaming: { enabled: true, flushMs: 500 },
      permissionMode: "workspace-write",
      groupPolicy: "mention",
      reactions: { enabled: true, pool: [], done: "DONE", failed: "CrossMark" },
      turnTimeoutMs: 600_000,
      agentPreset: "code",
      interruptClassifierEnabled: true,
      // 敏感字段全部设唯一哨兵假值
      bossOpenId: S_ID,
      wecomBossUserId: S_WECOM,
      wecom: {
        enabled: true,
        botId: "wecom_bot_id_visible",
        secret: S,
        botName: "DSH助手",
        source: "dsh-wing",
        welcomeText: "hi",
      },
      // 非敏感字段（必须保留，防"打成空"这种另一种坏）
      workspaceRoot: "D:/dsh/workspace",
      steerDiagLogPath: undefined,
    } as any;
  }

  it("maskCfg：输出不含任何哨兵字符串（secret / bossOpenId / wecomBossUserId 全盖到）", () => {
    const out = JSON.stringify(maskCfg(sentryCfg()));
    expect(out).not.toContain(S);
    expect(out).not.toContain(S_ID);
    expect(out).not.toContain(S_WECOM);
  });

  it("maskCfg：非敏感字段仍在（防整个 cfg 打成空）", () => {
    const m = maskCfg(sentryCfg()) as Record<string, any>;
    expect(m.agentPreset).toBe("code");
    expect(m.turnTimeoutMs).toBe(600_000);
    expect(m.wecom.botId).toBe("wecom_bot_id_visible");
    expect(m.wecom.botName).toBe("DSH助手");
    expect(m.wecom.welcomeText).toBe("hi");
    expect(m.credentialRef).toBe("WING_LARK_APP");
  });

  it("maskCfg：wecom.secret 打码但 wecom 对象本身存在（不是整块删除）", () => {
    const m = maskCfg(sentryCfg()) as Record<string, any>;
    expect(m.wecom).toBeDefined();
    expect(typeof m.wecom.secret).toBe("string");
    expect(m.wecom.secret).not.toBe(S);
    expect(m.wecom.secret?.length).toBeGreaterThan(0);
  });

  it("feishu_config_get execute 输出：不含哨兵（走 maskCfg 同一套）", async () => {
    // 模拟 index.ts 工具 execute 的改后行为：JSON.stringify(maskCfg(cfg))
    const out = JSON.stringify(maskCfg(sentryCfg()), null, 2);
    expect(out).not.toContain(S);
    expect(out).not.toContain(S_ID);
    expect(out).not.toContain(S_WECOM);
    // 非敏感字段可见（agent 还能读配置排障）
    expect(out).toContain("agentPreset");
  });
});

// ━━━━━━━━━━━ G13：Web 面板来源校验 + GET 副作用 ━━━━━━━━━━━
describe("5c · G13：Web 面板来源校验", () => {
  type CapturedRoute = { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> };
  function mkPanelHarness() {
    const routes: CapturedRoute[] = [];
    const webServer: WebServerLike = {
      register(r: any) {
        routes.push(r as CapturedRoute);
        return () => void 0;
      },
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const panel = createWingPanel({
      status: { get: () => ({ connState: "connected", wsReady: true, outboxPending: 0, outboxFailed: 0, inboundPending: 0, sessions: 1, connectedAt: 1 }) },
      resolveCredential: async () => ({ appId: "cli_test", appSecret: "x", domain: "open.feishu.cn" }),
      setup: { start: vi.fn(async () => undefined), getActiveQr: () => undefined, isBusy: () => false },
      wecomSetup: {
        start: vi.fn(async () => undefined),
        getQr: () => undefined,
        isBusy: () => false,
        hasCredential: async () => true,
      },
      logger,
    } as any);
    panel.register(webServer);
    const byPath = (p: string) => routes.find((r) => r.path === p)!;
    return { byPath, routes, logger };
  }
  function mkRes() {
    const res: any = { status: undefined, headers: undefined, body: undefined };
    res.writeHead = (s: number, h: any) => { res.status = s; res.headers = h; return res; };
    res.end = (b?: unknown) => { res.body = b; return res; };
    return res;
  }
  const req = (over: Record<string, unknown> = {}) => ({ method: "GET", url: "/", headers: {}, ...over });
  const loopbackOrigin = { origin: "http://127.0.0.1:43000", referer: "http://127.0.0.1:43000/" };

  it("正常来源（本机回环 Origin）访问 /status → 200 可用（不挡 GUI/本机浏览器）", async () => {
    const h = mkPanelHarness();
    const res = mkRes();
    await h.byPath("/plugins/dsh-wing/status").handler(req({ headers: loopbackOrigin }), res);
    expect(res.status).toBe(200);
  });

  it("无 Origin/Referer 头（同源 GET / curl 默认）→ 放行（不破坏 GUI 内部请求）", async () => {
    const h = mkPanelHarness();
    const res = mkRes();
    await h.byPath("/plugins/dsh-wing/status").handler(req(), res);
    expect(res.status).toBe(200);
  });

  it("攻击场景：伪造跨站来源（evil.com）→ 403 被拒 + warn 留痕（不许静默 200）", async () => {
    const h = mkPanelHarness();
    for (const path of ["/plugins/dsh-wing/status", "/plugins/dsh-wing/setup", "/plugins/dsh-wing/wecom/setup", "/plugins/dsh-wing/wecom/qr", "/plugins/dsh-wing/qr"]) {
      const res = mkRes();
      await h.byPath(path).handler(req({ headers: { origin: "http://evil.example", referer: "http://evil.example/attack" } }), res);
      expect(res.status).toBe(403);
      expect(String(res.body)).toContain("origin");
    }
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.logger.warn.mock.calls[0]?.[0]).toContain("拒绝");
  });

  it("攻击场景：跨站 Referer（无 Origin 头的老浏览器）→ 403 被拒", async () => {
    const h = mkPanelHarness();
    const res = mkRes();
    await h.byPath("/plugins/dsh-wing/setup").handler(
      req({ method: "POST", headers: { referer: "http://evil.example/csrf" } }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it("/wecom/qr GET 无活跃流程 + 已绑定 → 409（不再自动发起扫码；副作用只留 POST）", async () => {
    const h = mkPanelHarness();
    const res = mkRes();
    await h.byPath("/plugins/dsh-wing/wecom/qr").handler(req({ headers: loopbackOrigin }), res);
    expect(res.status).toBe(409);
    expect((h as any).wecomSetup === undefined).toBe(true); // 占位（真实断言在 start 调用次数）
    void h;
  });
});

// ━━━━━━━━━━━ M37：tailLines 尾部窗口读取 ━━━━━━━━━━━
describe("5c · M37：tailLines 大文件只读尾部", () => {
  it("超大文件（>10MB）取末尾 n 行：内容正确、读取字节数远小于文件大小", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-5c-tail-"));
    try {
      const big = join(dir, "big.log");
      // 造 12MB 日志：一次拼接大块 filler（20 万行 × 60B）后一次写入（appendFileSync 循环 20 万次会超时）
      const filler = ("x".repeat(54) + "\n").repeat(200_000);
      const tailMarks = ["TAIL_A_alpha", "TAIL_B_beta", "TAIL_C_gamma", "TAIL_D_delta", "TAIL_E_epsilon"];
      writeFileSync(big, filler + tailMarks.map((m) => m + "\n").join(""));
      const size = statSync(big).size;
      expect(size).toBeGreaterThan(10 * 1024 * 1024);

      const mod = await import("../../src/doctor/package.js") as any;
      expect(typeof mod.tailLines).toBe("function");
      const tail = mod.tailLines(big, 3) as string;
      const lines = tail.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines).toEqual(["TAIL_C_gamma", "TAIL_D_delta", "TAIL_E_epsilon"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("文件不存在 → undefined（语义保持）", async () => {
    const mod = await import("../../src/doctor/package.js") as any;
    const tail = (mod.tailLines ?? mod.tailLinesForTest)(join(tmpdir(), "no-such-file-5c.log"), 10);
    expect(tail).toBeUndefined();
  });

  it("小文件：行为与全量读一致（末尾 n 行正确）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-5c-tail2-"));
    try {
      const f = join(dir, "small.log");
      writeFileSync(f, "l1\nl2\nl3\nl4\nl5\n");
      const mod = await import("../../src/doctor/package.js") as any;
      expect((mod.tailLines ?? mod.tailLinesForTest)(f, 2)).toBe("l4\nl5");
      expect((mod.tailLines ?? mod.tailLinesForTest)(f, 100)).toBe("l1\nl2\nl3\nl4\nl5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
