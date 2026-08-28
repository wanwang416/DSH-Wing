import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "WING_LARK_APP: '{\"appId\":\"a\",\"appSecret\":\"s\",\"domain\":\"feishu\"}'"),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  defaultHttpInstance: { defaults: { proxy: true } },
  AppType: { SelfBuild: "APP_SELF" },
  Domain: { Lark: "DOMAIN_LARK", Feishu: "DOMAIN_FEISHU" },
  LoggerLevel: { info: "INFO", error: "ERROR", debug: "DEBUG" },
  WSClient: vi.fn(function (this: any, opts: any) {
    this.opts = opts;
    this.start = vi.fn();
    this.getConnectionStatus = vi.fn(() => "connected");
  }),
  EventDispatcher: vi.fn(function (this: any, opts: any) {
    this.opts = opts;
    this.register = vi.fn();
  }),
}));

import { readFileSync } from "node:fs";

describe("scripts/diag-listen.mjs（M2 排障脚本，mock 依赖覆盖）", () => {
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
    vi.mocked(readFileSync).mockImplementation(() => "WING_LARK_APP: '{\"appId\":\"a\",\"appSecret\":\"s\",\"domain\":\"feishu\"}'");
  });

  it("主路径：读凭据 + WSClient + dispatcher.register + start + 60s 后 DONE", async () => {
    vi.resetModules();
    await import("../../scripts/diag-listen.mjs");
    expect(log).toHaveBeenCalledWith("appId:", "a");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listening 60s"));
    // 60s 到期 → status + exit（主路径 exit 是回调最后一行，不抛即可走完）
    exit.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("DONE status="));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("无 WING_LARK_APP 凭据 → NO WING_LARK_APP + exit(1)", async () => {
    vi.resetModules();
    vi.mocked(readFileSync).mockReturnValue("OTHER_KEY: 'x'");
    await expect(import("../../scripts/diag-listen.mjs")).rejects.toThrow("process.exit");
    expect(log).toHaveBeenCalledWith("NO WING_LARK_APP");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
