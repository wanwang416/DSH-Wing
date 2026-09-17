import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  startWecomQrLogin,
  pollWecomQrLogin,
  cancelWecomQrLogin,
  resetWecomQrLoginsForTest,
  WECOM_POLL_INTERVAL_MS,
} from "../../src/setup/wecom-qr-auth.js";

/** 构造最小 fetch mock：按 URL 返回固定 JSON */
function makeFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

function okGenerate(scode = "sc_1") {
  return { data: { scode, auth_url: "https://work.weixin.qq.com/ai/qc/scan?t=abc" } };
}

/** 按调用顺序返回不同响应体（start 用 generate 响应，poll 用 query_result 响应） */
function makeSwitchFetch(bodies: unknown[]) {
  let i = 0;
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(bodies[Math.min(i++, bodies.length - 1)]),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  resetWecomQrLoginsForTest();
});
afterEach(() => {
  resetWecomQrLoginsForTest();
});

describe("startWecomQrLogin", () => {
  it("成功：返回 sessionKey / 白名单校验通过的 verificationUrl / expiresAt", async () => {
    const fetchImpl = makeFetch(okGenerate("sc_abc"));
    const res = await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res.sessionKey).toBe("k1");
    expect(res.verificationUrl).toContain("work.weixin.qq.com");
    expect(res.expiresAt).toBeGreaterThan(Date.now());
    expect(res.pollIntervalMs).toBe(WECOM_POLL_INTERVAL_MS);
    // 请求参数：source=dsh-wing、plat 存在
    const called = fetchImpl.mock.calls[0][0] as URL;
    expect(called.searchParams.get("source")).toBe("dsh-wing");
    expect(called.searchParams.get("plat")).toBeTruthy();
  });

  it("安全：auth_url 非 https → 抛错", async () => {
    const fetchImpl = makeFetch({ data: { scode: "s1", auth_url: "http://work.weixin.qq.com/ai/qc/scan?t=abc" } });
    await expect(startWecomQrLogin({ sessionKey: "k1", fetchImpl })).rejects.toThrow("返回数据无效");
  });

  it("安全：auth_url 非 work.weixin.qq.com 域名 → 抛错", async () => {
    const fetchImpl = makeFetch({ data: { scode: "s1", auth_url: "https://evil.example.com/scan" } });
    await expect(startWecomQrLogin({ sessionKey: "k1", fetchImpl })).rejects.toThrow("返回数据无效");
  });

  it("安全：auth_url 带非 443 端口 → 抛错", async () => {
    const fetchImpl = makeFetch({ data: { scode: "s1", auth_url: "https://work.weixin.qq.com:8080/scan" } });
    await expect(startWecomQrLogin({ sessionKey: "k1", fetchImpl })).rejects.toThrow("返回数据无效");
  });

  it("安全：auth_url 含用户信息 → 抛错", async () => {
    const fetchImpl = makeFetch({ data: { scode: "s1", auth_url: "https://u:p@work.weixin.qq.com/scan" } });
    await expect(startWecomQrLogin({ sessionKey: "k1", fetchImpl })).rejects.toThrow("返回数据无效");
  });

  it("复用：同 sessionKey 未过期流程直接返回原二维码（不再请求）", async () => {
    const fetchImpl = makeFetch(okGenerate("sc_1"));
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const second = await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.verificationUrl).toContain("work.weixin.qq.com");
  });

  it("force：强制重开（即使未过期也重新请求）", async () => {
    const fetchImpl = makeFetch(okGenerate("sc_1"));
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    await startWecomQrLogin({ sessionKey: "k1", force: true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("服务端 HTTP 错误 → 抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: vi.fn() }) as unknown as typeof fetch;
    await expect(startWecomQrLogin({ sessionKey: "k1", fetchImpl })).rejects.toThrow("HTTP 500");
  });
});

describe("pollWecomQrLogin", () => {
  it("success → 返回 botId + secret 并清理 session", async () => {
    const fetchImpl = makeSwitchFetch([okGenerate("sc_1"), { data: { status: "success", bot_info: { botid: "wb_1", secret: "sec_1" } } }]);
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res).toEqual({ connected: true, botId: "wb_1", secret: "sec_1" });
    // session 已清理 → 再 poll 报 not_started
    const again = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(again.connected).toBe(false);
    expect(again.status).toBe("not_started");
  });

  it("waiting → 继续等待", async () => {
    const fetchImpl = makeSwitchFetch([okGenerate("sc_1"), { data: { status: "waiting" } }]);
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res).toEqual({ connected: false, status: "waiting", message: expect.any(String) });
  });

  it("expired/timeout → expired 并清理", async () => {
    const fetchImpl = makeSwitchFetch([okGenerate("sc_1"), { data: { status: "expired" } }]);
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res.status).toBe("expired");
  });

  it("fail/error → failed 并清理", async () => {
    const fetchImpl = makeSwitchFetch([okGenerate("sc_1"), { data: { status: "fail" } }]);
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res.status).toBe("failed");
  });

  it("success 但凭据不完整 → failed", async () => {
    const fetchImpl = makeSwitchFetch([okGenerate("sc_1"), { data: { status: "success", bot_info: { botid: "wb_1" } } }]);
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res.connected).toBe(false);
    expect(res.status).toBe("failed");
  });

  it("未发起流程 → not_started", async () => {
    const fetchImpl = makeFetch({});
    const res = await pollWecomQrLogin({ sessionKey: "none", fetchImpl });
    expect(res.status).toBe("not_started");
  });
});

describe("cancelWecomQrLogin", () => {
  it("取消后 poll 报 not_started", async () => {
    const fetchImpl = makeFetch(okGenerate("sc_1"));
    await startWecomQrLogin({ sessionKey: "k1", fetchImpl });
    cancelWecomQrLogin("k1");
    const res = await pollWecomQrLogin({ sessionKey: "k1", fetchImpl });
    expect(res.status).toBe("not_started");
  });
});
