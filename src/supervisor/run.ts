import { existsSync } from "node:fs";
import { join } from "node:path";
import { deriveResult, type RunResult } from "./result";
import { systemdRunArgv, sliceName, unitName } from "./launch";
import type { BatchSpec, RunSpec } from "./spec";
import { batchesDir, ensureDir, newId, readJsonIfExists, runsDir, writeJsonAtomic } from "./store";

export interface RunRecord {
  runId: string;
  batchId: string;
  unit: string;
  slice: string;
  sessionId: string;
  spec: RunSpec;
  acceptedAt: number;
}

export interface LaunchEnvironment {
  root: string;
  piPath: string;
  shPath: string;
  finalizeCommand: (runDir: string) => string[];
  env: NodeJS.ProcessEnv;
}

export interface BatchSummary {
  batchId: string;
  runs: { runId: string; runDir: string }[];
}

function recordLaunchFailure(runDir: string, message: string): void {
  const result: RunResult = {
    ...deriveResult({ termination: null, cancel: null, events: "" }),
    outcome: "launch_failed",
    error: message,
  };
  writeJsonAtomic(join(runDir, "result.json"), result);
}

/** Accepts a validated batch, persists its records and launches every run. */
export function launchBatch(spec: BatchSpec, launchEnv: LaunchEnvironment): BatchSummary {
  const batchId = newId();
  ensureDir(batchesDir(launchEnv.root));
  const records: RunRecord[] = spec.runs.map((runSpec) => ({
    runId: newId(),
    batchId,
    unit: "",
    slice: sliceName(batchId),
    sessionId: crypto.randomUUID(),
    spec: runSpec,
    acceptedAt: Date.now(),
  }));
  for (const record of records) {
    record.unit = unitName(record.runId);
    const runDir = join(runsDir(launchEnv.root), record.runId);
    ensureDir(join(runDir, "session"));
    writeJsonAtomic(join(runDir, "run.json"), record);
  }
  writeJsonAtomic(join(batchesDir(launchEnv.root), `${batchId}.json`), {
    batchId,
    runIds: records.map((record) => record.runId),
    acceptedAt: Date.now(),
  });

  const runs = records.map((record) => {
    const runDir = join(runsDir(launchEnv.root), record.runId);
    const argv = systemdRunArgv({
      runId: record.runId,
      batchId,
      runDir,
      spec: record.spec,
      sessionId: record.sessionId,
      piPath: launchEnv.piPath,
      shPath: launchEnv.shPath,
      finalizeCommand: launchEnv.finalizeCommand(runDir),
      env: launchEnv.env,
    });
    const proc = Bun.spawnSync(argv, { env: launchEnv.env, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      recordLaunchFailure(runDir, `systemd-run exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
    }
    return { runId: record.runId, runDir };
  });
  return { batchId, runs };
}

/** Polls until every run of the batch has a result.json. */
export async function waitForResults(
  batch: BatchSummary,
  pollMs = 500,
): Promise<{ runId: string; result: RunResult }[]> {
  const pending = new Set(batch.runs.map((run) => run.runDir));
  while (pending.size > 0) {
    for (const runDir of pending) if (existsSync(join(runDir, "result.json"))) pending.delete(runDir);
    if (pending.size > 0) await Bun.sleep(pollMs);
  }
  return batch.runs.map((run) => ({
    runId: run.runId,
    result: readJsonIfExists<RunResult>(join(run.runDir, "result.json"))!,
  }));
}
