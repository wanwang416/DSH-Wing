/**
 * M4.2 Web 面板改造 · setup-flow 单测
 *
 * createSetupFlow 是飞书 /setup 与 DSH Web 面板共用的扫码注册核心流程：
 *   - 双触发：chatId 有值 → 完成/失败通知；undefined（Web 触发）→ 静默
 *   - activeQr：onQRCodeReady 生成 PNG，/qr route 经 getActiveQr() 读取
 *   - 防重：流程进行中第二次 start 返回 undefined
 *   - 超时：二维码 30s 内未就绪 → abort 并返回 undefined
 *
 * registerAppWithFetch 走全局 fetch，用 mock fetch 模拟 begin/poll 立即授权。
 */
import { describe, expect, it, vi } from "vitest";
import { createSetupFlow, type SetupFlowDeps } from "../../src/setup/setup-flow.js";

/** mock 全局 fetch：begin 返回二维码，poll 立即返回明文凭据 */
function stubFetchHappy(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(init?.body ?? "").includes("action=begin")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          verification_uri_complete: "https://open.feishu.cn/page/cli?user_code=TEST",
          device_code: "dev_1",
          expires_in: 600,
          interval: 0,
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ client_id: "cli_web_1", client_secret: "sec_web_1", user_info: { tenant_brand: "feishu" } }),
    } as unknown as Response;
  }));
}

/** 后台流程收尾等待（begin→poll→persist→restart 全异步） */
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function makeDeps(overrides: Partial<SetupFlowDeps> = {}) {
  const deps: SetupFlowDeps & { notify: ReturnType<typeof vi.fn>; failNotify: ReturnType<typeof vi.fn>; persist: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> } = {
    persist: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    notify: vi.fn(),
    failNotify: vi.fn(),
    ...overrides,
  } as never;
  return deps;
}

describe("createSetupFlow", () => {
  it("Web 触发（chatId=undefined）→ 完成且静默：persist/restart 执行，notify 不调", async () => {
    stubFetchHappy();
    const deps = makeDeps();
    const flow = createSetupFlow(deps);
    const res = await flow.start(undefined);
    expect(res?.url).toContain("user_code=TEST");
    expect(res?.expireIn).toBe(600);
    await settle();
    expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({ appId: "cli_web_1", appSecret: "sec_web_1" }));
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.failNotify).not.toHaveBeenCalled();
    expect(flow.isBusy()).toBe(false);
  });

  it("飞书触发（chatId='chat1'）→ 完成后 notify(appId, domain)", async () => {
    stubFetchHappy();
    const deps = makeDeps();
    const flow = createSetupFlow(deps);
    const res = await flow.start("chat1");
    expect(res?.url).toContain("user_code=TEST");
    await settle();
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith("chat1", "cli_web_1", "feishu");
    expect(deps.failNotify).not.toHaveBeenCalled();
  });

  it("注册失败 → failNotify(chatId, message)，不 persist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(init?.body ?? "").includes("action=begin")) {
        return { ok: true, status: 200, json: async () => ({
          verification_uri_complete: "https://qr", device_code: "dev", expires_in: 60, interval: 0,
        }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ error: "access_denied", error_description: "user declined" }) } as unknown as Response;
    }));
    const deps = makeDeps();
    const flow = createSetupFlow(deps);
    await flow.start("chat1");
    await settle();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.failNotify).toHaveBeenCalledWith("chat1", expect.stringContaining("user declined"));
    expect(flow.isBusy()).toBe(false);
  });

  it("防重：流程进行中第二次 start 返回 undefined（不重复注册）", async () => {
    stubFetchHappy();
    // persist 挂起 → 后台流程永不结束 → inflight 保持 true
    const deps = makeDeps({ persist: vi.fn(() => new Promise(() => {})) });
    const flow = createSetupFlow(deps);
    // 第一次 start 立即返回二维码，但后台 persist 仍挂起
    await flow.start(undefined);
    const second = await flow.start(undefined);
    expect(second).toBeUndefined();
    expect(deps.persist).toHaveBeenCalledTimes(1); // 只注册一次
  });

  it("activeQr：QR 就绪后 getActiveQr 返回 PNG buffer，完成后清空", async () => {
    stubFetchHappy();
    // persist 用 gate 卡住后台 → 流程停在 persist，activeQr 可被 toPngBuffer 写入
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps({ persist: vi.fn(() => gate) });
    const flow = createSetupFlow(deps);
    await flow.start(undefined);
    // onQRCodeReady → toPngBuffer 异步生成 PNG（QRCode.toBuffer），等待一小段
    await settle(150);
    const qr = flow.getActiveQr();
    expect(qr?.png).toBeInstanceOf(Buffer);
    expect(qr && qr.png.length).toBeGreaterThan(100); // PNG 头+数据
    expect(qr && qr.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
    // 释放 persist → 流程完成 → activeQr 清空（epoch 递增使挂起的写入失效，不复活）
    release();
    await settle(200);
    expect(flow.getActiveQr()).toBeUndefined();
  });

  it("超时：二维码 30s 未就绪 → 返回 undefined 并释放防重锁", async () => {
    vi.useFakeTimers();
    try {
      // fetch 永不 resolve，但响应 signal.abort（begin 请求挂起，超时后 ac.abort() 生效）
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(new Error("Registration was aborted"));
          signal?.addEventListener("abort", () => reject(new Error("Registration was aborted")));
        });
      }));
      const deps = makeDeps();
      const flow = createSetupFlow(deps);
      const p = flow.start(undefined);
      await vi.advanceTimersByTimeAsync(31_000);
      const res = await p;
      expect(res).toBeUndefined();
      // abort 生效 → 后台 catch → finally inflight 复位
      await vi.advanceTimersByTimeAsync(100);
      expect(flow.isBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
