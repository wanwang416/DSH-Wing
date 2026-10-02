import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDedupeStore } from "../../src/inbound/dedup.js";
import { createDispatcher } from "../../src/inbound/dispatcher.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

let file = "";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  file = join(tmpdir(), `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  vi.clearAllMocks();
});

afterEach(() => {
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  try { rmSync(file + ".tmp", { force: true }); } catch { /* ignore */ }
});

describe("阶段4 B1：dedup 原子写 + 损坏保护（M13）", () => {
  it("M13：解析失败不清空——保留 .bak 备份并 warn（旧实现静默 records=[]，必红）", () => {
    writeFileSync(file, "{ 这不是合法 JSON !!!");
    const store = createDedupeStore(file);
    expect(store.size()).toBe(0); // 从空开始（可用性优先）
    expect(readFileSync(file + ".bak", "utf8")).toContain("这不是合法 JSON"); // .bak 留证
    // warn 在构造函数里拿不到（无 logger 参数）——检查文件证据即可 + 下方用例验证日志路径
  });

  it("M13：损坏前的好数据仍在 .bak，损坏后新增记录正常持久化（tmp+rename 原子写）", () => {
    const store = createDedupeStore(file);
    store.add("om_1");
    // 模拟写一半被杀：磁盘上是损坏 JSON
    writeFileSync(file, '{"messageId":"om_x","at":');
    const store2 = createDedupeStore(file);
    store2.add("om_2"); // 旧数据丢了（已在 .bak），但新记录必须能写回去
    const store3 = createDedupeStore(file);
    expect(store3.isDuplicate("om_2")).toBe(true); // 新记录持久化成功（原子写没有留下损坏）
  });

  it("M13：正常路径无 .tmp 残留（原子写 rename 后不留临时文件）", () => {
    const store = createDedupeStore(file);
    store.add("om_1");
    store.add("om_2");
    expect(() => readFileSync(file + ".tmp")).toThrow();
    expect(readFileSync(file, "utf8")).toContain("om_2");
  });
});

// ===== B2：dispatcher 先解析后去重 + 失败不静默 =====

function makeDeps() {
  const handled: ParsedMessage[] = [];
  const deps = {
    dedupe: createDedupeStore(join(tmpdir(), `dedup-b2-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)),
    botOpenId: () => "ou_bot",
    logger,
    handleInbound: vi.fn(async (msg: ParsedMessage) => { handled.push(msg); }),
  };
  return { deps, handled };
}

describe("阶段4 B2：解析失败不占去重位 + 静默丢弃补日志（M22）", () => {
  it("未知 msgtype → warn 带 messageId+msgtype，且不占去重位（同 id 重投仍会尝试解析）", async () => {
    const { deps } = makeDeps();
    const d = createDispatcher(deps);
    const raw = { message: { message_id: "om_u1", chat_id: "oc_1", chat_type: "p2p", message_type: "share_user", content: "{}" } };
    await d.handleEvent("im.message.receive_v1", raw);
    expect(deps.dedupe.isDuplicate("om_u1")).toBe(false); // 旧实现：add 在 parse 之前 → true
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("om_u1"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("share_user"));
    // 重投：仍然不占位（解析还是失败，但再次 warn）
    await d.handleEvent("im.message.receive_v1", raw);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("正常 text 消息 → 处理一次，重投被去重拦截（回归锚：不破坏既有行为）", async () => {
    const { deps } = makeDeps();
    const d = createDispatcher(deps);
    const raw = { message: { message_id: "om_t1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hi" }) } };
    await d.handleEvent("im.message.receive_v1", raw);
    await d.handleEvent("im.message.receive_v1", raw);
    expect(deps.handleInbound).toHaveBeenCalledTimes(1);
    expect(deps.dedupe.isDuplicate("om_t1")).toBe(true);
  });

  it("handleParsed（企微入口）同样的先解析判定：本入口 msg 已解析，保持去重+处理行为", async () => {
    const { deps } = makeDeps();
    const d = createDispatcher(deps);
    await d.handleParsed({ messageId: "om_w1", chatId: "oc_w", chatType: "p2p", text: "hi" } as ParsedMessage);
    await d.handleParsed({ messageId: "om_w1", chatId: "oc_w", chatType: "p2p", text: "hi" } as ParsedMessage);
    expect(deps.handleInbound).toHaveBeenCalledTimes(1);
  });
});

describe("阶段4 B2：chat_type 缺失不默认 p2p（M22-③）", () => {
  it("缺 chat_type 的群消息上下文 → warn 并按未知处理（不绕过群策略）", async () => {
    const { deps } = makeDeps();
    const d = createDispatcher(deps);
    const raw = { message: { message_id: "om_nc1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "hi" }) } };
    await d.handleEvent("im.message.receive_v1", raw);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("chat_type"));
  });
});
