/**
 * ★ 阶段 5 X5 攻击场景回归（2026-10-02）
 *
 * 覆盖：
 *  1. 非老板提权 → 被拒（fail-closed）
 *  2. operatorId 缺失 → 提权被拒（fail-closed）
 *  3. 老板提权 → 放行
 *  4. override 落盘 → 重建实例仍在（重启保留）
 *  5. A 会话设 danger-full-access 不影响 B 会话（per-chat 隔离）
 *  6. 卡片回调入口：非老板点 danger-full-access → 拒绝回执 + 不落盘
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionOverrideStore, checkPermissionChange } from "../../src/session/permission-overrides.js";
import { createInteractiveRouter } from "../../src/interactive/router.js";

describe("X5 · checkPermissionChange（共用提权判定）", () => {
  it("攻击场景：非老板提权 danger-full-access → 拒绝", () => {
    const deny = checkPermissionChange({
      target: "danger-full-access",
      operatorId: "ou_attacker",
      bossOpenId: "ou_boss",
      wecomBossUserId: "wecom_boss",
    });
    expect(deny).not.toBeNull();
    expect(deny).toContain("老板");
  });

  it("攻击场景：operatorId 缺失（取不到身份）→ 提权拒绝，不许宽松放行", () => {
    expect(checkPermissionChange({ target: "danger-full-access", operatorId: undefined, bossOpenId: "ou_boss" })).not.toBeNull();
    expect(checkPermissionChange({ target: "danger-full-access", operatorId: "unknown", bossOpenId: "ou_boss" })).not.toBeNull();
    // boss 身份未配置 → 同样拒绝（fail-closed）
    expect(checkPermissionChange({ target: "danger-full-access", operatorId: "ou_someone", bossOpenId: undefined })).not.toBeNull();
  });

  it("老板提权 → 放行（飞书 openId 或企微 userid 任一命中）", () => {
    expect(checkPermissionChange({ target: "danger-full-access", operatorId: "ou_boss", bossOpenId: "ou_boss" })).toBeNull();
    expect(checkPermissionChange({ target: "danger-full-access", operatorId: "wecom_boss", wecomBossUserId: "wecom_boss" })).toBeNull();
  });

  it("降级/常规（read-only / workspace-write）→ 任何人放行（只改本会话）", () => {
    expect(checkPermissionChange({ target: "read-only", operatorId: "ou_anyone", bossOpenId: "ou_boss" })).toBeNull();
    expect(checkPermissionChange({ target: "workspace-write", operatorId: undefined })).toBeNull();
  });
});

describe("X5 · createPermissionOverrideStore", () => {
  it("override 落盘 → 重建实例仍在（重启保留）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-perm-"));
    try {
      const file = join(dir, "permission-overrides.json");
      const s1 = createPermissionOverrideStore(file);
      s1.set("oc_1", "danger-full-access");
      expect(existsSync(file)).toBe(true);
      const s2 = createPermissionOverrideStore(file); // 模拟重启
      expect(s2.get("oc_1")).toBe("danger-full-access");
      expect(s2.resolveFor("oc_1", "workspace-write")).toBe("danger-full-access");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A 会话设全开不影响 B 会话（per-chat 隔离，旧全局单例会污染）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-perm-"));
    try {
      const file = join(dir, "permission-overrides.json");
      const store = createPermissionOverrideStore(file);
      store.set("oc_A", "danger-full-access");
      // B 未设置 → 用配置默认值，不被 A 拉高
      expect(store.resolveFor("oc_B", "workspace-write")).toBe("workspace-write");
      // 旧实现：runtime.permissionMode 全局一把 → B 也变全开。新实现必须隔离。
      expect(store.resolveFor("oc_A", "workspace-write")).toBe("danger-full-access");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("手改文件注入非法模式值 → 丢弃（不进 applyPermission）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-perm-"));
    try {
      const file = join(dir, "permission-overrides.json");
      writeFileSync(file, JSON.stringify({ oc_bad: "sudo-all", oc_ok: "read-only" }));
      const store = createPermissionOverrideStore(file);
      expect(store.get("oc_bad")).toBeUndefined();
      expect(store.get("oc_ok")).toBe("read-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("解析失败 → 保留 .bak 不静默清空（M14 同款教训）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-perm-"));
    try {
      const file = join(dir, "permission-overrides.json");
      writeFileSync(file, "{broken json!!");
      createPermissionOverrideStore(file);
      expect(existsSync(`${file}.bak`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("X5 · 卡片回调入口（interactiveRouter 集成）", () => {
  function mkRouter(opts: { checkPermissionChange?: (t: string, op?: string) => string | null }) {
    const setPermissionMode = vi.fn(() => true);
    const reply = vi.fn();
    const router = createInteractiveRouter({
      runtime: {
        getPermissionMode: () => "workspace-write",
        setPermissionMode,
        getAgentPreset: () => "code",
        setAgentPreset: () => void 0,
      },
      modelRegistry: {
        setOverride: vi.fn(),
        clearOverride: vi.fn(),
        hasOverride: vi.fn(() => false),
        liveFor: vi.fn(() => ({ provider: "d", model: "m" })),
        getModelDefault: vi.fn(() => undefined),
      } as any,
      reply,
      checkPermissionChange: opts.checkPermissionChange,
    } as any);
    return { router, setPermissionMode, reply };
  }

  it("攻击场景：非老板点 danger-full-access → 拒绝回执 + setPermissionMode 不被调", async () => {
    const { router, setPermissionMode, reply } = mkRouter({
      checkPermissionChange: (t, op) => (t === "danger-full-access" && op !== "ou_boss" ? "完全访问是老板专属权限，仅老板本人可开启。" : null),
    });
    const consumed = await router.onCardAction("oc_1", "mode:danger-full-access", "ou_attacker");
    expect(consumed).toBe(true); // 消费（不再透传），但拒绝落盘
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("🚫"));
  });

  it("老板点 danger-full-access → 落盘本会话 + 确认回执", async () => {
    const { router, setPermissionMode, reply } = mkRouter({
      checkPermissionChange: (t, op) => (t === "danger-full-access" && op !== "ou_boss" ? "拒绝" : null),
    });
    const consumed = await router.onCardAction("oc_1", "mode:danger-full-access", "ou_boss");
    expect(consumed).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith("danger-full-access", "oc_1");
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("本会话"));
  });

  it("拒绝路径必须留痕（warn 日志）", async () => {
    const warn = vi.fn();
    const setPermissionMode = vi.fn(() => true);
    const router = createInteractiveRouter({
      runtime: {
        getPermissionMode: () => "workspace-write",
        setPermissionMode,
        getAgentPreset: () => "code",
        setAgentPreset: () => void 0,
      },
      modelRegistry: {
        setOverride: vi.fn(), clearOverride: vi.fn(), hasOverride: vi.fn(() => false),
        liveFor: vi.fn(() => ({ provider: "d", model: "m" })), getModelDefault: vi.fn(() => undefined),
      } as any,
      reply: vi.fn(),
      logger: { warn },
      checkPermissionChange: () => "拒绝",
    } as any);
    await router.onCardAction("oc_1", "mode:danger-full-access", "ou_attacker");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("权限切换被拒"));
  });
});
