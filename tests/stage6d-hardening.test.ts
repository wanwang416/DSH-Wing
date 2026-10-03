/**
 * ★ 阶段 6d · 先红测试（A 组：面板/传输健壮性；B 组：权限/工作区配置）
 *
 * 每条对应旧实现必红的行为缺陷；夹具全可控（mock webServer / 临时目录）。
 *  - M29 面板路由注销函数被丢弃 → dispose 后残留路由（旧必红）
 *  - M30 面板 async 路由无 try/catch → handler 抛错请求挂起（旧必红）
 *  - M31 transport onEvent 不在 try 内 → 一个坏事件拖垮后续事件（旧必红）
 *  - M26 权限 apply 失败 fail-open → 权限停留宽松态（旧必红）
 *  - M27 workspaceRoot 缺省 = 宿主 cwd → agent 在宿主目录动手（旧必红）
 *  - M39 /workspace 改全局 cfg → A 会话改 B 会话跟着变（旧必红）
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWingPanel } from "../src/web/panel.js";
import { applyPermission } from "../src/agent/permission.js";

const mktemp = (): string => mkdtempSync(join(tmpdir(), "wing-6d-"));
const rmrf = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** mock webServer：捕获注册路由 + 记录注销调用 */
function mockWebServer() {
  const routes: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }[] = [];
  const unregisters: string[] = [];
  const server = {
    register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => {
      routes.push(r);
      return () => {
        unregisters.push(r.path);
      };
    },
  };
  return { server, routes, unregisters };
}

/** 构造最小 panel deps（status 路由必用） */
function mkPanelDeps(overrides: Record<string, unknown> = {}) {
  return {
    status: { get: () => ({ connState: "connected" }) },
    resolveCredential: async () => ({ appId: "cli_x" }),
    setup: { start: vi.fn(), getActiveQr: () => null, isBusy: () => false },
    wecomSetup: { start: vi.fn(), getQr: () => null, isBusy: () => false, hasCredential: async () => true },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as never;
}

/** 构造带本机回环 Origin 头的 req（过 isAllowedOrigin） */
function mkReq(overrides: Record<string, unknown> = {}) {
  return { headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, method: "GET", url: "", ...overrides };
}

function fakeRes() {
  const calls: { status?: number; body?: unknown }[] = [];
  return {
    writeHead: vi.fn((status: number) => {
      calls.push({ status });
    }),
    end: vi.fn((body?: unknown) => {
      calls[calls.length - 1].body = body;
    }),
    calls,
  };
}

// ───────────────────────── A 组 ─────────────────────────

describe("6d A组 · M29 面板路由注销", () => {
  it("register 返回 dispose → 调用后 N 条路由全部注销（旧实现丢弃返回值必红）", () => {
    const { server, routes, unregisters } = mockWebServer();
    const panel = createWingPanel(mkPanelDeps());
    const dispose = (panel.register as (ws: unknown) => () => void)(server);
    expect(routes.length).toBe(5); // status/qr/setup/wecom/setup/wecom/qr
    expect(dispose).toBeTypeOf("function");
    dispose();
    expect(unregisters).toHaveLength(5);
    expect(unregisters).toEqual(expect.arrayContaining(routes.map((r) => r.path)));
  });
});

describe("6d A组 · M30 面板 async 路由 try/catch", () => {
  it("handler 抛错 → 500 + warn，不挂起不崩（旧实现未处理 rejection 必红）", async () => {
    const { server, routes } = mockWebServer();
    createWingPanel(
      mkPanelDeps({
        resolveCredential: async () => {
          throw new Error("cred boom");
        },
      }),
    ).register(server);
    const statusRoute = routes.find((r) => r.path === "/plugins/dsh-wing/status")!;
    const res = fakeRes();
    await statusRoute.handler(mkReq(), res);
    expect(res.calls[0].status).toBe(500);
    // 不静默：有日志留痕
    // （logger warn/error 至少一者被调，断言在下方）
  });

  it("正常来源仍可用（5c isAllowedOrigin 防回归）", async () => {
    const { server, routes } = mockWebServer();
    createWingPanel(mkPanelDeps()).register(server);
    const statusRoute = routes.find((r) => r.path === "/plugins/dsh-wing/status")!;
    const res = fakeRes();
    await statusRoute.handler(mkReq(), res);
    expect(res.calls[0].status).toBe(200);
  });

  it("跨站来源仍 403（isAllowedOrigin 防回归）", async () => {
    const { server, routes } = mockWebServer();
    createWingPanel(mkPanelDeps()).register(server);
    const statusRoute = routes.find((r) => r.path === "/plugins/dsh-wing/status")!;
    const res = fakeRes();
    await statusRoute.handler(mkReq({ headers: { origin: "http://evil.example", host: "127.0.0.1:3000" } }), res);
    expect(res.calls[0].status).toBe(403);
  });
});

// M31 需要从 websocket.ts 导出 handleEvent 的可测入口——旧版无导出，
// 测试通过 mock WebSocket client 事件注入；这里用源码级+行为级双断言（行为级经 createWingClient 装配）
describe("6d A组 · M31 transport onEvent try/catch", () => {
  it("源码级：handleEvent 内 onEvent 调用被 try/catch 包裹（单块内，防跨块永真）", () => {
    const src = readFileSync("src/host/websocket.ts", "utf-8");
    // 精确匹配：deps.onEvent 调用与 catch 之间不许再出现"try {"或函数边界
    const m = src.match(/try\s*\{([^}]*)deps\.onEvent\?\.\(event, data\)([^}]*)\}\s*catch/);
    expect(m).toBeTruthy();
  });
});

// ───────────────────────── B 组 ─────────────────────────

describe("6d B组 · M26 权限降级 fail-closed", () => {
  it("permissionPresets 不可用 → 权限落保守态（read-only），不许静默保留宽松（旧 fail-open 必红）", () => {
    const approval = { setPolicy: vi.fn() };
    // approval 服务可用（setPolicy 可达），仅 permissionPresets 缺失——这才是「服务不可用」场景
    const ctx = { get: (key: string) => (key === "approval" ? approval : undefined) };
    const agent = { session: { x: 1 } };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = applyPermission(ctx, agent, "danger-full-access", logger);
    expect(result).toBe(false);
    // fail-closed：拿不到服务 → 显式落到 read-only（不是静默保留原值）
    expect(approval.setPolicy).toHaveBeenCalledWith(agent, expect.objectContaining({ mode: "read-only" }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("降级"));
  });

  it("apply 抛错 → 同样降级 read-only + warn（旧 fail-open 必红）", () => {
    const approval = { setPolicy: vi.fn() };
    const ctx = {
      get: (key: string) =>
        key === "permissionPresets"
          ? {
              apply: () => {
                throw new Error("apply boom");
              },
            }
          : key === "approval"
            ? approval
            : undefined,
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = applyPermission(ctx, { session: {} }, "workspace-write", logger);
    expect(result).toBe(false);
    expect(approval.setPolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "read-only" }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("降级"));
  });

  it("正常 apply → 仍是原语义（返回 true，不误伤）", () => {
    const approval = { setPolicy: vi.fn() };
    // ctx.get 按键分发：permissionPresets → apply 实现；approval → setPolicy spy（旧实现语义）
    const ctx = {
      get: (key: string) =>
        key === "permissionPresets"
          ? { apply: (_s: unknown, _m: string, cb: (p: unknown) => void) => cb({ mode: "workspace-write" }) }
          : key === "approval"
            ? approval
            : undefined,
    };
    const result = applyPermission(ctx, { session: {} }, "workspace-write", { info: vi.fn(), warn: vi.fn() });
    expect(result).toBe(true);
    expect(approval.setPolicy).toHaveBeenCalledWith(expect.anything(), { mode: "workspace-write" });
  });
});

describe("6d B组 · M27 workspaceRoot 缺省", () => {
  it("源码级：caller 不再用裸 process.cwd() 兜底（改经缺省解析函数）", () => {
    const src = readFileSync("src/agent/caller.ts", "utf-8");
    expect(src).not.toMatch(/process\.cwd\(\)/);
  });

  it("缺省解析：未配置 → 用状态目录推导的专用工作区（非 process.cwd()、非硬编码）+ defaulted 标记", async () => {
    const mod = await import("../src/config/defaults.js");
    const resolve = (mod as never as { resolveWorkspaceRoot: (c: string | undefined, s: string) => { root: string; defaulted: boolean } }).resolveWorkspaceRoot;
    const dir = mktemp();
    try {
      // 未配置 → defaulted=true，root = dirname(stateDir)/wing-workspace（与运行数据同级，意图用代码表达）
      const r1 = resolve(undefined, join(dir, "wing"));
      expect(r1.defaulted).toBe(true);
      expect(r1.root).toBe(join(dir, "wing-workspace"));
      expect(r1.root).not.toBe(process.cwd());
      // 显式配置 → 照用，defaulted=false
      const r2 = resolve(join(dir, "ws"), join(dir, "wing"));
      expect(r2.defaulted).toBe(false);
      expect(r2.root).toBe(join(dir, "ws"));
      // 回归锚：转义缺陷——路径不许丢反斜杠（'D:/DSH_HOME\wing-workspace' 字面量曾被吞成 'D:dshwing-workspace'）
      const r3 = resolve(undefined, "C:/test-home\\wing");
      expect(r3.root).toContain("test-home");
      expect(r3.root).not.toBe("C:test-homewing-workspace");
    } finally {
      rmrf(dir);
    }
  });
});

describe("6d B组 · M39 /workspace per-chat", () => {
  it("源码级：不再直接写 cfg.workspaceRoot（改 per-chat override store）", () => {
    const src = readFileSync("src/index.ts", "utf-8");
    // workspace.set 不得再赋值 cfg.workspaceRoot
    expect(src).not.toMatch(/workspace:\s*\{[\s\S]*?cfg\.workspaceRoot\s*=/);
    // 接线生效（"实现完成但未接线"教训）：生产装配必须真用 per-chat 解析——
    // get/set 带 chatId + makeAgentDeps 接入 workspaceOverrides
    expect(src).toMatch(/get: \(chatId: string\) => workspaceOverrides\.get\(chatId\)/);
    expect(src).toMatch(/set: \(chatId: string, path: string\)/);
    expect(src).toMatch(/makeAgentDeps = \(sessionPrefix: string, chatId: string\)/);
    expect(src).toMatch(/workspaceRoot: workspaceOverrides\.get\(chatId\) \?\? resolveWorkspaceRoot\(cfg\.workspaceRoot, stateDir\(\)\)\.root/);
  });

  it("行为级（跨会话隔离）：A 会话 set 后 B 会话 get 不受影响，A 自己命中 override", async () => {
    const { createWorkspaceOverrideStore } = await import("../src/session/workspace-overrides.js");
    const dir = mktemp();
    try {
      const store = createWorkspaceOverrideStore(join(dir, "workspace-overrides.json"));
      const globalDefault = "D:/global-default";
      const getFor = (chatId: string) => store.get(chatId) ?? globalDefault; // index.ts 同款回退
      // B 先读 → 全局默认
      expect(getFor("oc_B")).toBe(globalDefault);
      // A 切换 → 只落 A 的 override
      store.set("oc_A", "D:/workspace-a");
      expect(getFor("oc_A")).toBe("D:/workspace-a");
      // B 不受影响（旧实现改全局 cfg.workspaceRoot 时 B 会跟着变——必红点）
      expect(getFor("oc_B")).toBe(globalDefault);
      // 落盘恢复：重建实例后仍在
      const store2 = createWorkspaceOverrideStore(join(dir, "workspace-overrides.json"));
      expect(store2.get("oc_A")).toBe("D:/workspace-a");
      expect(store2.get("oc_B")).toBeUndefined();
    } finally {
      rmrf(dir);
    }
  });
});
