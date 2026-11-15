import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveResult, type CancelIntent, type RunResult, type TerminationEvidence } from "./result";
import { readJsonIfExists, writeJsonAtomic } from "./store";

/** Reads the termination evidence systemd passes to ExecStopPost. */
export function terminationFromEnv(env: NodeJS.ProcessEnv, now: number): TerminationEvidence {
  return {
    serviceResult: env.SERVICE_RESULT ?? "",
    exitCode: env.EXIT_CODE ?? "",
    exitStatus: env.EXIT_STATUS ?? "",
    finalizedAt: now,
  };
}

/** Derives result.json from the files of a run directory. Idempotent. */
export function deriveRunDir(runDir: string): RunResult {
  const termination = readJsonIfExists<TerminationEvidence>(join(runDir, "outcome.json"));
  const cancel = readJsonIfExists<CancelIntent>(join(runDir, "cancel"));
  const eventsPath = join(runDir, "events.jsonl");
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  const result = deriveResult({ termination, cancel, events });
  writeJsonAtomic(join(runDir, "result.json"), result);
  return result;
}

/** ExecStopPost entry point: records the outcome, then derives the result. */
export function finalize(runDir: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  const outcomePath = join(runDir, "outcome.json");
  if (!existsSync(outcomePath)) writeJsonAtomic(outcomePath, terminationFromEnv(env, now));
  deriveRunDir(runDir);
}
