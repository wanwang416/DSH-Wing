import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getConfig } from "../../src/config/defaults.js";

describe("getConfig", () => {
  it("空 rawConfig → 全默认值", () => {
    const cfg = getConfig({}, undefined);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.credentialRef).toBe("WING_LARK_APP");
    expect(cfg.streaming.enabled).toBe(true);
    expect(cfg.permissionMode).toBe("workspace-write");
    expect(cfg.groupPolicy).toBe("mention");
    expect(cfg.reactions.enabled).toBe(true);
    expect(cfg.turnTimeoutMs).toBe(600_000);
    expect(cfg.agentPreset).toBe("code");
  });

  it("rawConfig 覆盖顶层", () => {
    const cfg = getConfig({}, { credentialRef: "MY_REF", groupPolicy: "open" });
    expect(cfg.credentialRef).toBe("MY_REF");
    expect(cfg.groupPolicy).toBe("open");
  });

  it("rawConfig 嵌套深合并（streaming/reactions）", () => {
    const cfg = getConfig({}, { streaming: { enabled: false }, reactions: { done: "DONE2" } });
    expect(cfg.streaming.enabled).toBe(false);
    expect(cfg.streaming.flushMs).toBe(DEFAULT_CONFIG.streaming.flushMs); // 保留默认
    expect(cfg.reactions.done).toBe("DONE2");
    expect(cfg.reactions.pool).toEqual(DEFAULT_CONFIG.reactions.pool); // 保留默认
  });

  it("ctx 不影响结果", () => {
    const cfg = getConfig({ config: { wing: { enabled: false } } }, {});
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});

describe("getConfig：企微（S1 三态 / D7a source）", () => {
  it("wecom.enabled 缺省 undefined（不显式关闭；有凭据即自动启用）", () => {
    const cfg = getConfig({}, {});
    expect(cfg.wecom.enabled).toBeUndefined();
    const on = getConfig({}, { wecom: { enabled: true } });
    expect(on.wecom.enabled).toBe(true);
    const off = getConfig({}, { wecom: { enabled: false } });
    expect(off.wecom.enabled).toBe(false);
  });
  it("wecom.source 默认无；raw 覆盖（D7a）", () => {
    const cfg = getConfig({}, {});
    expect(cfg.wecom.source).toBeUndefined();
    const cfg2 = getConfig({}, { wecom: { source: "my-wing" } });
    expect(cfg2.wecom.source).toBe("my-wing");
  });
});

