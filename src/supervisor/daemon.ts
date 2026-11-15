import { setTimeout } from "node:timers/promises";
import { reconcile } from "./reconcile";

export interface ReconcileLoopOptions {
  signal: AbortSignal;
  intervalMs?: number;
  reconcileRuns?: typeof reconcile;
  report?: (states: ReturnType<typeof reconcile>) => void;
}

/** Reconciles at startup and periodically until stopped, without launching runs. */
export async function reconcileLoop(root: string, options: ReconcileLoopOptions): Promise<void> {
  const { signal, intervalMs = 5_000, reconcileRuns = reconcile, report = console.log } = options;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("reconciliation interval must be a positive integer");
  }
  let previous: string | undefined;
  while (!signal.aborted) {
    const states = reconcileRuns(root);
    const snapshot = JSON.stringify(states);
    if (snapshot !== previous) report(states);
    previous = snapshot;
    try {
      await setTimeout(intervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
