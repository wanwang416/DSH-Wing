import { describe, expect, it, vi } from "vitest";
import { applyPermission } from "../../src/agent/permission.js";

function ctx(overrides: Record<string, unknown> = {}) {
  const permission = {
    apply: vi.fn((_session: unknown, _mode: string, cb: (policy: unknown) => void) => cb({ mode: "workspace-write" })),
  };
  const approval = { setPolicy: vi.fn() };
  return {
    get: vi.fn((key: string) => (key === "permissionPresets" ? permission : key === "approval" ? approval : undefined)),
    ...overrides,
  } as any;
}

describe("applyPermission", () => {
  it("服务齐全 → 应用权限 + 回调 setPolicy + info", () => {
    const c = ctx();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const agent = { session: "sess_1" };
    const ok = applyPermission(c, agent, "workspace-write", logger);
    expect(ok).toBe(true);
    expect(c.get).toHaveBeenCalledWith("permissionPresets");
    expect(c.get("approval").setPolicy).toHaveBeenCalledWith(agent, { mode: "workspace-write" });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("权限已设为 workspace-write"));
  });

  it("permissionPresets 不可用 → warn + false", () => {
    const c = ctx({ get: vi.fn().mockReturnValue(undefined) });
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(applyPermission(c, { session: "s" }, "workspace-write", logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("permissionPresets 服务不可用"));
  });

  it("agent 无 session → warn + false", () => {
    const c = ctx();
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(applyPermission(c, {}, "workspace-write", logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("permissionPresets 服务不可用"));
  });

  it("apply 抛错 → warn 失败 + false", () => {
    const c = ctx({
      get: vi.fn((key: string) =>
        key === "permissionPresets" ? { apply: vi.fn(() => { throw new Error("boom"); }) } : { setPolicy: vi.fn() }
      ),
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(applyPermission(c, { session: "s" }, "workspace-write", logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("权限设置失败"));
  });
});
