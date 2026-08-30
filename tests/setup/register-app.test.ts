/**
 * M4.2 /setup 扫码建应用 · device-code 流程测试
 *
 * registerAppWithFetch 走全局 fetch（wire 协议对齐飞书官方
 * accounts.feishu.cn/oauth/v1/app/registration）。用 mock fetch 模拟 begin/poll。
 */
import { describe, expect, it, vi } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createAuthSetup,
  detectDomain,
  encodeAddons,
  registerAppWithFetch,
  type RegisterAppFn,
} from "../../src/setup/register-app.js";
import type { SetupAddons } from "../../src/setup/addons.js";

/** base64url 解码 + gunzip → JSON（还原 encodeAddons 输入） */
function decodeAddons(encoded: string): SetupAddons {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(b64, "base64");
  return JSON.parse(gunzipSync(raw).toString("utf8")) as SetupAddons;
}

describe("detectDomain", () => {
  it("tenant_brand=lark → lark（国际版）", () => {
    expect(detectDomain({ tenant_brand: "lark" })).toBe("lark");
  });
  it("undefined/feishu → feishu（国内版）", () => {
    expect(detectDomain(undefined)).toBe("feishu");
    expect(detectDomain({ tenant_brand: "feishu" })).toBe("feishu");
  });
});

describe("encodeAddons", () => {
  it("base64url(gzip) 可无损还原原始 JSON", () => {
    const addons = {
      scopes: { tenant: ["im:message"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
      callbacks: { items: ["card.action.trigger"] },
    };
    const encoded = encodeAddons(addons);
    expect(encoded).not.toContain("="); // base64url 无 padding
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(decodeAddons(encoded)).toEqual(addons);
  });

  it("空 scopes 也编码为合法 gzip JSON", () => {
    const encoded = encodeAddons({});
    expect(decodeAddons(encoded)).toEqual({});
  });
});

describe("createAuthSetup（流程编排）", () => {
  it("registerApp → 扫码 → persist → 返回明文凭据", async () => {
    const qrReady: Array<{ url: string; expireIn: number }> = [];
    const statuses: string[] = [];
    const persisted: unknown[] = [];
    const fakeRegister: RegisterAppFn = async ({ onQRCodeReady, onStatusChange }) => {
      onStatusChange?.({ status: "polling" });
      onQRCodeReady({ url: "https://qr.example/xxx", expireIn: 600 });
      return {
        client_id: "cli_new_app_1",
        client_secret: "sec_new_app_1",
        user_info: { tenant_brand: "feishu" },
      };
    };
    const setup = createAuthSetup({
      registerApp: fakeRegister,
      persist: async (c) => { persisted.push(c); },
      addons: { scopes: { tenant: ["im:message"] } },
    });
    const res = await setup.run({
      onQRCodeReady: (i) => qrReady.push(i),
      onStatusChange: (s) => statuses.push(s),
    });
    expect(res).toEqual({ appId: "cli_new_app_1", appSecret: "sec_new_app_1", domain: "feishu" });
    expect(persisted).toEqual([res]);
    expect(qrReady[0].url).toBe("https://qr.example/xxx");
    expect(statuses.at(-1)).toBe("完成 ✅");
  });

  it("addons 缺省 → 注入 buildSetupAddons() 默认配置", async () => {
    let captured: { addons?: SetupAddons } | undefined;
    const fakeRegister: RegisterAppFn = async (opts) => {
      captured = opts;
      opts.onQRCodeReady({ url: "u", expireIn: 60 });
      return { client_id: "id", client_secret: "sec", user_info: {} };
    };
    await createAuthSetup({ registerApp: fakeRegister, persist: async () => {} }).run({
      onQRCodeReady: () => {},
    });
    expect(captured?.addons?.events?.items?.tenant).toContain("im.message.receive_v1");
  });

  it("registerApp 缺 client_secret → 抛错，不 persist", async () => {
    const persisted: unknown[] = [];
    const fakeRegister: RegisterAppFn = async ({ onQRCodeReady }) => {
      onQRCodeReady({ url: "u", expireIn: 60 });
      return { client_id: "id", user_info: {} }; // 无 secret
    };
    await expect(
      createAuthSetup({ registerApp: fakeRegister, persist: async (c) => { persisted.push(c); } }).run({
        onQRCodeReady: () => {},
      }),
    ).rejects.toThrow("client_id/client_secret");
    expect(persisted).toEqual([]);
  });

  it("registerApp 抛错 → 透传", async () => {
    const fakeRegister: RegisterAppFn = async () => {
      throw new Error("registration begin failed: network");
    };
    await expect(
      createAuthSetup({ registerApp: fakeRegister, persist: async () => {} }).run({ onQRCodeReady: () => {} }),
    ).rejects.toThrow("network");
  });

  it("signal abort → 注册流程被取消（错误透传）", async () => {
    const ac = new AbortController();
    let sawSignal = false;
    const fakeRegister: RegisterAppFn = async ({ signal }) => {
      sawSignal = !!signal;
      if (signal?.aborted) throw new Error("Registration was aborted");
      return { client_id: "id", client_secret: "sec", user_info: {} };
    };
    ac.abort(); // 调用前已 abort → registerApp 应拒绝而非成功
    await expect(
      createAuthSetup({ registerApp: fakeRegister, persist: async () => {} }).run({
        onQRCodeReady: () => {},
        signal: ac.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(sawSignal).toBe(true);
  });
});

describe("registerAppWithFetch（wire 协议，mock fetch）", () => {
  function mockFetchOnce(handler: (url: string, init?: RequestInit) => Record<string, unknown>): void {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const data = handler(url, init);
      return {
        ok: !data.error,
        status: data.error ? 400 : 200,
        json: async () => data,
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("begin 返回二维码 → poll 轮询 → 授权返回明文 client_id/secret", async () => {
    const calls: string[] = [];
    mockFetchOnce((url, init) => {
      const body = String(init?.body ?? ""); // action 在 form body，不在 URL
      calls.push(body);
      if (body.includes("action=begin")) {
        return {
          verification_uri_complete: "https://open.feishu.cn/page/cli?user_code=ABC123",
          device_code: "dev_1",
          expires_in: 600,
          interval: 0, // 测试提速：真实协议 ≥5s，mock 0 避免 sleep 阻塞超时
        };
      }
      // poll：先 pending 一次，再授权完成
      if (calls.filter((c) => c.includes("action=poll")).length === 1) {
        return { error: "authorization_pending" };
      }
      return { client_id: "cli_final", client_secret: "sec_final", user_info: { tenant_brand: "feishu" } };
    });

    const qrReady: Array<{ url: string; expireIn: number }> = [];
    const register = registerAppWithFetch();
    const res = await register({
      onQRCodeReady: (i) => qrReady.push(i),
      onStatusChange: () => {},
    });
    expect(res.client_id).toBe("cli_final");
    expect(res.client_secret).toBe("sec_final");
    expect(qrReady[0].url).toContain("user_code=ABC123");
    // 二维码 URL 带 sdk 参数（source 透传 dsh-wing）；addons 透传由独立测试覆盖
    expect(qrReady[0].url).toContain("from=sdk");
    expect(qrReady[0].url).toContain("source=node-sdk%2Fdsh-wing");
    expect(qrReady[0].url).not.toContain("addons="); // 未传 addons → 不加参数
    expect(qrReady[0].expireIn).toBe(600);
  });

  it("poll access_denied → 抛错并给 error_description", async () => {
    mockFetchOnce((url, init) => {
      if (String(init?.body ?? "").includes("action=begin")) {
        return { verification_uri_complete: "https://qr", device_code: "dev", expires_in: 60, interval: 5 };
      }
      return { error: "access_denied", error_description: "user declined" };
    });
    await expect(registerAppWithFetch()({ onQRCodeReady: () => {}, onStatusChange: () => {} })).rejects.toThrow(
      "user declined",
    );
  });

  it("begin 无 verification_uri → 抛错", async () => {
    mockFetchOnce(() => ({ error: "invalid_request", error_description: "bad begin" }));
    await expect(registerAppWithFetch()({ onQRCodeReady: () => {} })).rejects.toThrow("bad begin");
  });

  it("HTTP 非 ok 且无 error 字段 → 传输错误", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerAppWithFetch()({ onQRCodeReady: () => {} })).rejects.toThrow("HTTP 500");
  });

  it("addons 参数编码透传（verify gzip 可解）", async () => {
    mockFetchOnce((url, init) => {
      if (String(init?.body ?? "").includes("action=begin")) {
        return { verification_uri_complete: "https://qr", device_code: "dev", expires_in: 60, interval: 5 };
      }
      return { client_id: "id", client_secret: "sec", user_info: {} };
    });
    const qrReady: Array<{ url: string }> = [];
    await registerAppWithFetch()({
      addons: { scopes: { tenant: ["im:message"] }, events: { items: { tenant: ["im.message.receive_v1"] } }, callbacks: { items: [] } },
      onQRCodeReady: (i) => qrReady.push(i),
    });
    const addonsParam = new URL(qrReady[0].url).searchParams.get("addons") ?? "";
    expect(decodeAddons(addonsParam).scopes?.tenant).toContain("im:message");
    // 注意：URLSearchParams 已把 base64url 的 -_ 字符按 safe 编码，可能变 %2D——验证 gzip 还原仍成功
    const decoded = decodeAddons(decodeURIComponent(addonsParam));
    expect(decoded.events?.items?.tenant).toContain("im.message.receive_v1");
  });

  it("gzipSync 工具自检：encodeAddons 与 decodeAddons 往返一致", () => {
    const addons = { scopes: { tenant: ["a", "b"] } };
    const encoded = encodeAddons(addons);
    expect(gunzipSync(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toString()).toBe(
      JSON.stringify(addons),
    );
    expect(gzipSync).toBeDefined();
  });
});
