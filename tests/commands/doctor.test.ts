/**
 * M4.2 /doctor 命令测试（一键生成诊断包）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { doctorCommand } from "../../src/commands/doctor.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

const msg = (): ParsedMessage => ({
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "p2p",
  userId: "ou_1",
  text: "/doctor",
  rawText: "/doctor",
  mentions: [],
  timestamp: Date.now(),
});

describe("/doctor", () => {
  it("服务可用 → 返回 ZIP 路径 + 大小", async () => {
    const generate = vi.fn(async () => ({ zipPath: "C:/tmp/doctor-1.zip", size: 2048 }));
    const ctx = { services: { doctor: { generate } } } as BridgeCommandContext;
    const res = await doctorCommand.run(ctx, "", msg());
    expect(generate).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("doctor-1.zip");
    expect(res?.text).toContain("2.0");
  });

  it("服务不可用 → 提示", async () => {
    const ctx = {} as BridgeCommandContext;
    const res = await doctorCommand.run(ctx, "", msg());
    expect(res?.text).toContain("不可用");
  });
});
