/**
 * M4.2 /setup 二维码渲染测试
 */
import { describe, expect, it } from "vitest";
import { toAsciiQr, qrHint } from "../../src/setup/qrcode.js";

describe("toAsciiQr", () => {
  it("有效 URL → 渲染 ASCII 网格（块字符 + 换行）", async () => {
    const qr = await toAsciiQr("https://open.feishu.cn/page/cli?user_code=ABC");
    expect(typeof qr).toBe("string");
    expect(qr.length).toBeGreaterThan(0);
    expect(qr).toContain("\n");
  });

  it("空串 URL 也不抛错（降级容忍）", async () => {
    const qr = await toAsciiQr("");
    expect(typeof qr).toBe("string");
  });
});

describe("qrHint", () => {
  it("含过期秒数与扫码引导", () => {
    const hint = qrHint(600);
    expect(hint).toContain("600 秒后过期");
    expect(hint).toContain("扫码");
  });
});
