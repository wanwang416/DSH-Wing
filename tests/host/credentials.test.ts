import { describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "../../src/host/credentials.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    credentials: {
      resolve: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      unset: vi.fn().mockResolvedValue(undefined),
      ...(overrides as any),
    },
  };
}

describe("createCredentialStore", () => {
  it("resolve: DSH 返回 {value: JSON 字符串} → 解析出凭据", async () => {
    const ctx = makeCtx();
    (ctx.credentials as any).resolve.mockResolvedValue({ value: '{"appId":"a1","appSecret":"s1","domain":"feishu"}' });
    const cred = await createCredentialStore(ctx).resolve("WING_LARK_APP");
    expect(cred).toEqual({ appId: "a1", appSecret: "s1", domain: "feishu" });
  });

  it("resolve: 直接返回对象 → 原样使用", async () => {
    const ctx = makeCtx();
    (ctx.credentials as any).resolve.mockResolvedValue({ appId: "a2", appSecret: "s2", domain: "lark" });
    const cred = await createCredentialStore(ctx).resolve("ref");
    expect(cred).toEqual({ appId: "a2", appSecret: "s2", domain: "lark" });
  });

  it("resolve: 无值 → undefined", async () => {
    const ctx = makeCtx();
    (ctx.credentials as any).resolve.mockResolvedValue(undefined);
    expect(await createCredentialStore(ctx).resolve("ref")).toBeUndefined();
  });

  it("resolve: value 非 JSON → undefined", async () => {
    const ctx = makeCtx();
    (ctx.credentials as any).resolve.mockResolvedValue({ value: "not-json" });
    expect(await createCredentialStore(ctx).resolve("ref")).toBeUndefined();
  });

  it("resolve: JSON 缺 appSecret → undefined", async () => {
    const ctx = makeCtx();
    (ctx.credentials as any).resolve.mockResolvedValue({ value: '{"appId":"a1"}' });
    expect(await createCredentialStore(ctx).resolve("ref")).toBeUndefined();
  });

  it("resolve: ctx.credentials 不存在 → undefined 不崩", async () => {
    const ctx: any = {};
    expect(await createCredentialStore(ctx).resolve("ref")).toBeUndefined();
  });

  it("set → 序列化 JSON 写入", async () => {
    const ctx = makeCtx();
    const store = createCredentialStore(ctx);
    await store.set("ref", { appId: "a", appSecret: "s", domain: "feishu" });
    expect(ctx.credentials.set).toHaveBeenCalledWith("ref", '{"appId":"a","appSecret":"s","domain":"feishu"}');
  });

  it("unset → 调用底层 unset", async () => {
    const ctx = makeCtx();
    const store = createCredentialStore(ctx);
    await store.unset("ref");
    expect(ctx.credentials.unset).toHaveBeenCalledWith("ref");
  });
});
