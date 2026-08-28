import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "WING_LARK_APP: '{\"appId\":\"a\",\"appSecret\":\"s\",\"domain\":\"lark\"}'"),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  defaultHttpInstance: { defaults: { proxy: true } },
  AppType: { SelfBuild: "APP_SELF" },
  Domain: { Lark: "DOMAIN_LARK", Feishu: "DOMAIN_FEISHU" },
  LoggerLevel: { info: "INFO", error: "ERROR", debug: "DEBUG" },
  WSClient: vi.fn(function (this: any, opts: any) {
    this.opts = opts;
    this.start = vi.fn();
    this.getConnectionStatus = vi.fn(() => ({ connected: true }));
  }),
  EventDispatcher: vi.fn(function (this: any, opts: any) {
    this.opts = opts;
    this.register = vi.fn();
  }),
}));

import { readFileSync } from "node:fs";

describe("scripts/diag-ws.mjs（M1 排障脚本，mock 依赖覆盖）", () => {
  let log: any;
  let exit: any;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
  });
  afterEach(() => {
    vi.useRealTimers();
    log.mockRestore();
    exit.mockRestore();
    vi.mocked(readFileSync).mockImplementation(() => "WING_LARK_APP: '{\"appId\":\"a\",\"appSecret\":\"s\",\"domain\":\"lark\"}'");
  });

  it("主路径：读凭据 + proxy disabled + wsClient.start + 15s 后 STATUS", async () => {
    vi.resetModules();
    await import("../../scripts/diag-ws.mjs");
    expect(log).toHaveBeenCalledWith("appId:", "a", "domain:", "lark");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("proxy disabled"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("wsClient.start() called"));
    // 15s 到期 → STATUS + exit（主路径 exit 是回调最后一行，不抛即可走完）
    exit.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("STATUS: "));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("无 WING_LARK_APP 凭据 → NO WING_LARK_APP + exit(1)", async () => {
    vi.resetModules();
    vi.mocked(readFileSync).mockReturnValue("OTHER: 'x'");
    await expect(import("../../scripts/diag-ws.mjs")).rejects.toThrow("process.exit");
    expect(log).toHaveBeenCalledWith("NO WING_LARK_APP credential");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
