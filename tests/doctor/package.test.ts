/**
 * M4.2 /doctor 诊断包生成测试（ZIP + 脱敏 + 模板）
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { createDoctorPackage, mask, maskCfg, maskCredential, pluginVersion } from "../../src/doctor/package.js";
import { DEFAULT_CONFIG, type WingConfig } from "../../src/config/defaults.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "dsh-wing-doctor-"));
}

describe("doctor 脱敏纯函数", () => {
  it("mask：过短/空 → ***，长值保留前 4 位", () => {
    expect(mask("cli_test1234567890ab")).toBe("cli_******");
    expect(mask("abc")).toBe("***");
    expect(mask(undefined)).toBe("***");
  });

  it("maskCredential：appSecret 全打码、appId 打码首尾、domain 保留", () => {
    const m = maskCredential({ appId: "cli_aa03ee45", appSecret: "topsecret", domain: "feishu" });
    expect(m.appSecret).toBe("***");
    expect(m.appId).not.toContain("aa03");
    expect(m.domain).toBe("feishu");
  });

  it("maskCfg：bossOpenId 打码，其余配置保留", () => {
    const cfg = { ...DEFAULT_CONFIG, bossOpenId: "ou_boss123" } as WingConfig;
    const m = maskCfg(cfg);
    expect(m.bossOpenId).not.toContain("ou_boss");
    expect(m.permissionMode).toBe("workspace-write");
  });

  it("pluginVersion：从插件自身位置读版本（不依赖 cwd，DSH 进程 cwd 是 D:\\dsh）", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(pluginVersion()).toBe(pkg.version);
    expect(pluginVersion()).not.toBe("unknown");
  });
});

describe("createDoctorPackage", () => {
  it("生成 ZIP：日志+脱敏配置+ISSUE+README，凭据打码", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "dsh-wing.log"), "line1\nline2\nline3\n");
      const cfg = { ...DEFAULT_CONFIG, bossOpenId: "ou_boss" } as WingConfig;
      const r = await createDoctorPackage({
        stateDir: dir,
        cfg,
        credential: { appId: "cli_aa03ee45", appSecret: "super-secret", domain: "feishu" },
        pluginVersion: "0.0.1",
        now: new Date("2026-08-29T00:00:00.000Z"),
      });
      expect(existsSync(r.zipPath)).toBe(true);
      expect(r.size).toBeGreaterThan(0);

      const zip = await JSZip.loadAsync(await readFileSync(r.zipPath));
      const names = Object.keys(zip.files);
      expect(names).toContain("dsh-wing.log");
      expect(names).toContain("config.json");
      expect(names).toContain("ISSUE.md");
      expect(names).toContain("README.txt");
      expect(r.entries.sort()).toEqual(
        expect.arrayContaining(["dsh-wing.log", "config.json", "ISSUE.md", "README.txt"]),
      );

      const cfgJson = JSON.parse(await zip.file("config.json")!.async("string"));
      expect(cfgJson.credential.appSecret).toBe("***");
      expect(cfgJson.credential.appId).not.toContain("aa03");
      expect(cfgJson.bossOpenId).not.toContain("ou_boss");

      const issue = await zip.file("ISSUE.md")!.async("string");
      expect(issue).toContain("node:");
      expect(issue).toContain("dshWing: 0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("日志缺失 → 跳过收录，仍生成 ZIP（核心模板齐全）", async () => {
    const dir = tmpDir();
    try {
      const r = await createDoctorPackage({
        stateDir: dir,
        cfg: DEFAULT_CONFIG,
        pluginVersion: "0.0.1",
        now: new Date("2026-08-29T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(await readFileSync(r.zipPath));
      const names = Object.keys(zip.files);
      expect(names).not.toContain("dsh-wing.log");
      expect(names).toContain("config.json");
      expect(names).toContain("ISSUE.md");
      expect(names).toContain("README.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
