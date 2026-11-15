import { expect, test } from "bun:test";
import { reconcileLoop } from "./daemon";

test("reconciles immediately and periodically, reporting only changed states", async () => {
  const controller = new AbortController();
  const reports: unknown[] = [];
  let calls = 0;
  await reconcileLoop("/state", {
    signal: controller.signal,
    intervalMs: 1,
    reconcileRuns: (root) => {
      expect(root).toBe("/state");
      calls++;
      if (calls === 3) controller.abort();
      return { run: calls < 3 ? "running" : "derived" };
    },
    report: (states) => reports.push(states),
  });
  expect(calls).toBe(3);
  expect(reports).toEqual([{ run: "running" }, { run: "derived" }]);
});

test("stops promptly while waiting without another reconciliation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const loop = reconcileLoop("/state", {
    signal: controller.signal,
    intervalMs: 60_000,
    reconcileRuns: () => { calls++; return {}; },
    report: () => {},
  });
  controller.abort();
  await loop;
  expect(calls).toBe(1);
});

test("rejects invalid intervals and propagates reconciliation failures", async () => {
  for (const intervalMs of [0, -1, NaN, Infinity, 0.5]) {
    await expect(reconcileLoop("/state", {
      signal: new AbortController().signal,
      intervalMs,
    })).rejects.toThrow("positive integer");
  }
  await expect(reconcileLoop("/state", {
    signal: new AbortController().signal,
    reconcileRuns: () => { throw new Error("unit state unavailable"); },
  })).rejects.toThrow("unit state unavailable");
});
