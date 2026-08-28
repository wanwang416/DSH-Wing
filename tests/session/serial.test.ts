import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../../src/session/serial.js";

describe("createSerialQueue（per-chat 串行锁）", () => {
  it("同 key 串行执行（按入队顺序）", async () => {
    const q = createSerialQueue();
    const order: number[] = [];
    await Promise.all([
      q.enqueue("k1", async () => { await Promise.resolve(); order.push(1); }),
      q.enqueue("k1", async () => { await Promise.resolve(); order.push(2); }),
      q.enqueue("k1", async () => { await Promise.resolve(); order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("不同 key 并行执行", async () => {
    const q = createSerialQueue();
    let started = 0;
    const tasks = Promise.all([
      q.enqueue("a", async () => { started++; await new Promise((r) => setTimeout(r, 20)); }),
      q.enqueue("b", async () => { started++; await new Promise((r) => setTimeout(r, 20)); }),
    ]);
    await tasks;
    expect(started).toBe(2);
  });

  it("task 抛错 → 不影响后续任务且调用方可捕获", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const p1 = q.enqueue("k", async () => { throw new Error("boom"); }).catch(() => order.push("p1-caught"));
    const p2 = q.enqueue("k", async () => { order.push("p2"); });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["p1-caught", "p2"]);
  });

  it("size / clear", async () => {
    const q = createSerialQueue();
    expect(q.size()).toBe(0);
    const p = q.enqueue("k", async () => {});
    expect(q.size()).toBe(1);
    q.clear();
    expect(q.size()).toBe(0);
    await p;
  });

  it("enqueue 返回的 promise 可 await 拿到返回值", async () => {
    const q = createSerialQueue();
    const res = await q.enqueue("k", async () => "done");
    expect(res).toBe("done");
  });
});
