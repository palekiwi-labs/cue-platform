import { existsSync } from "node:fs";
import { join } from "node:path";
import { systemctlIsLive } from "./reconcile";
import { cleanupWorktree } from "./worktree";
import type { CancelIntent } from "./result";
import type { RunRecord } from "./run";
import { batchesDir, readJsonIfExists, runsDir, writeJsonAtomic } from "./store";

export type CancelTarget = { kind: "run"; runId: string } | { kind: "batch"; batchId: string };

export interface CancelReport {
  requested: string[];
  alreadyFinished: string[];
  stopped: string[];
}

export type StopUnits = (units: string[]) => void;

export function systemctlStop(units: string[]): void {
  if (units.length === 0) return;
  Bun.spawnSync(["systemctl", "--user", "stop", ...units], { stdout: "ignore", stderr: "ignore" });
}

function batchRunIds(root: string, batchId: string): string[] {
  const batch = readJsonIfExists<{ runIds: string[] }>(join(batchesDir(root), `${batchId}.json`));
  if (batch === null) throw new Error(`unknown batch ${batchId}`);
  return batch.runIds;
}

/**
 * Persists a cancel intent for every unfinished target run, then stops the
 * run unit or the batch slice. A recorded outcome or an earlier intent is
 * never overwritten.
 */
export function cancel(
  root: string,
  target: CancelTarget,
  stop: StopUnits = systemctlStop,
  now = Date.now(),
): CancelReport {
  const runIds = target.kind === "run" ? [target.runId] : batchRunIds(root, target.batchId);
  const report: CancelReport = { requested: [], alreadyFinished: [], stopped: [] };
  const units: string[] = [];
  let slice: string | null = null;
  for (const runId of runIds) {
    const runDir = join(runsDir(root), runId);
    const record = readJsonIfExists<RunRecord>(join(runDir, "run.json"));
    if (record === null) throw new Error(`unknown run ${runId}`);
    slice = record.slice;
    if (existsSync(join(runDir, "outcome.json")) || existsSync(join(runDir, "result.json"))) {
      report.alreadyFinished.push(runId);
      continue;
    }
    const cancelPath = join(runDir, "cancel");
    if (!existsSync(cancelPath)) writeJsonAtomic(cancelPath, { requestedAt: now } satisfies CancelIntent);
    report.requested.push(runId);
    units.push(record.unit);
  }
  const toStop = target.kind === "batch" && slice !== null && units.length > 0 ? [slice] : units;
  stop(toStop);
  report.stopped = toStop;
  for (const runId of runIds) {
    const runDir = join(runsDir(root), runId);
    const record = readJsonIfExists<RunRecord>(join(runDir, "run.json"))!;
    if (record.worktree && !systemctlIsLive(record.unit)) cleanupWorktree(runDir, record);
  }
  return report;
}
