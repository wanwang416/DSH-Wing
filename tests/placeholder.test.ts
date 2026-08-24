import { describe, expect, it } from "vitest";

describe("dsh-wing placeholder", () => {
  it("sanity: plugin name is exported", async () => {
    const mod = await import("../src/index.js");
    expect(mod.name).toBe("dsh-feishu-bridge");
    expect(typeof mod.apply).toBe("function");
    expect(typeof mod.stateDir).toBe("function");
  });
});
