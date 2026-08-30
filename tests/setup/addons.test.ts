/**
 * M4.2 /setup addons 配置测试（创建应用时一次性配好权限+事件）
 */
import { describe, expect, it } from "vitest";
import {
  buildSetupAddons,
  REQUIRED_EVENT,
  SETUP_EVENTS,
  SETUP_SCOPES,
} from "../../src/setup/addons.js";

describe("buildSetupAddons", () => {
  it("结构：scopes.tenant + events.items.tenant + callbacks.items 齐备", () => {
    const addons = buildSetupAddons();
    expect(addons.scopes?.tenant?.length).toBeGreaterThan(0);
    expect(addons.events?.items?.tenant?.length).toBeGreaterThan(0);
    expect(addons.callbacks?.items).toEqual(["card.action.trigger"]);
    expect(addons.user).toBeUndefined(); // 纯 tenant 配置
    expect(addons.events?.items?.user).toBeUndefined();
  });

  it("必需事件 im.message.receive_v1 在订阅清单内（缺它 bot 收不到消息）", () => {
    expect(SETUP_EVENTS).toContain(REQUIRED_EVENT);
    expect(buildSetupAddons().events?.items?.tenant).toContain(REQUIRED_EVENT);
  });

  it("scope 清单含消息收发 + 群/私聊（桥依赖能力）", () => {
    for (const need of ["im:message", "im:message.send_as_bot", "im:message.p2p_msg", "im:message.group_at_msg", "im:chat"]) {
      expect(SETUP_SCOPES).toContain(need);
    }
  });

  it("每次调用返回新数组（不共享引用，防意外改动污染）", () => {
    const a = buildSetupAddons();
    const b = buildSetupAddons();
    expect(a).not.toBe(b);
    expect(a.scopes?.tenant).not.toBe(b.scopes?.tenant);
  });
});
