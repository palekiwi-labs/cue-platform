import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupWorktree } from "./worktree";
import { deriveRunDir } from "./finalize";
import { deriveResult } from "./result";
import type { RunRecord } from "./run";
import { readJsonIfExists, runsDir, writeJsonAtomic } from "./store";

export type ReconcileState = "finished" | "derived" | "running" | "pending" | "unknown";

export type UnitIsLive = (unit: string) => boolean;

const LIVE_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing", "maintenance"]);
const DEAD_STATES = new Set(["inactive", "failed", "unknown"]);

export function systemctlIsLive(unit: string): boolean {
  const proc = Bun.spawnSync(["systemctl", "--user", "is-active", unit], { stdout: "pipe", stderr: "pipe" });
  const state = proc.stdout.toString().trim();
  if (proc.stderr.length > 0 || (!LIVE_STATES.has(state) && !DEAD_STATES.has(state))) {
    throw new Error(`cannot determine unit state: ${proc.stderr.toString().trim() || state}`);
  }
  return LIVE_STATES.has(state);
}

/**
 * Settles every run without a result: derives it from a recorded outcome,
 * leaves live units and freshly accepted runs alone, and marks the rest
 * unknown. Runs are never relaunched.
 */
export function reconcile(
  root: string,
  isLive: UnitIsLive = systemctlIsLive,
  now = Date.now(),
  graceMs = 60_000,
): Record<string, ReconcileState> {
  const dir = runsDir(root);
  const states: Record<string, ReconcileState> = {};
  if (!existsSync(dir)) return states;
  for (const runId of readdirSync(dir)) {
    const runDir = join(dir, runId);
    const record = readJsonIfExists<RunRecord>(join(runDir, "run.json"));
    if (record === null) continue;
    if (existsSync(join(runDir, "result.json"))) {
      states[runId] = "finished";
    } else if (existsSync(join(runDir, "outcome.json"))) {
      deriveRunDir(runDir);
      states[runId] = "derived";
    } else if (isLive(record.unit)) {
      states[runId] = "running";
    } else if (!existsSync(join(runDir, "started.json")) && now - record.acceptedAt < graceMs) {
      states[runId] = "pending";
    } else {
      const eventsPath = join(runDir, "events.jsonl");
      const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
      const cancel = readJsonIfExists<{ requestedAt: number }>(join(runDir, "cancel"));
      writeJsonAtomic(join(runDir, "result.json"), deriveResult({ termination: null, cancel, events }));
      states[runId] = "unknown";
    }
    if (record.worktree && existsSync(join(runDir, "result.json")) && !isLive(record.unit)) {
      cleanupWorktree(runDir, record);
    }
  }
  return states;
}
