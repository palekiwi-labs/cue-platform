import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CompatSpecError,
  fromCueAgentSpec,
  receiptExitCode,
  toCueAgentRun,
  type TranslatedBatch,
} from "../pi/lib/cue-agent-compat";
import { parseAgentList } from "../pi/lib/delegate-helpers";
import { isTerminal, supervisorRoster } from "../pi/lib/supervisor-client";
import { connectSupervisor, fetchRuns, submitWithRetry } from "../pi/lib/supervisor-nats";
import type { TerminationEvidence } from "./result";
import { readJsonIfExists, runsDir, stateRoot } from "./store";

const POLL_MS = 2_000;

function loadSpec(path: string): TranslatedBatch {
  const roster = supervisorRoster(
    parseAgentList(execFileSync("cue-agent", ["agents", "list", "--json"], { encoding: "utf8" })),
  );
  return fromCueAgentSpec(JSON.parse(readFileSync(path, "utf8")), roster);
}

function timing(runPath: string) {
  const started = readJsonIfExists<{ startedAt?: number }>(join(runPath, "started.json"));
  const termination = readJsonIfExists<TerminationEvidence>(join(runPath, "outcome.json"));
  return {
    startedAt: typeof started?.startedAt === "number" ? started.startedAt : null,
    finishedAt: typeof termination?.finalizedAt === "number" ? termination.finalizedAt : null,
  };
}

/**
 * `submit --wait --spec <file>`: run a cue-agent batch spec on the
 * supervisor and print a cue-agent-shaped receipt. Exit codes follow
 * cue-agent: 0 all succeeded, 1 a run did not, 2 rejected before launch,
 * 130 interrupted (the batch is cancelled first).
 */
export async function submitCommand(specPath: string, requestId: string = randomUUID()): Promise<number> {
  let batch: TranslatedBatch;
  try {
    batch = loadSpec(specPath);
  } catch (error) {
    if (error instanceof CompatSpecError || error instanceof SyntaxError) {
      console.error(`invalid spec: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const client = await connectSupervisor();
  const interrupted = new AbortController();
  const onSignal = () => interrupted.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const { batchId, runIds } = await submitWithRetry(client, `submit-${requestId}`, { runs: batch.runs });
    console.error(`batch ${batchId}: ${runIds.join(" ")}`);
    let states = await fetchRuns(client, "result", batchId, runIds);
    while (!states.every(isTerminal)) {
      if (interrupted.signal.aborted) {
        await client.request("cancel", { kind: "batch", batchId }).catch(() => undefined);
        console.error(`interrupted; cancellation requested for batch ${batchId}`);
        return 130;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      states = await fetchRuns(client, "result", batchId, runIds);
    }
    const root = runsDir(stateRoot());
    const runs = states.map((state, i) => {
      const runPath = join(root, state.runId);
      return toCueAgentRun(batchId, batch.agents[i], batch.labels[i], state, runPath, timing(runPath));
    });
    console.log(JSON.stringify({ batch_id: batchId, harness: "supervisor", harness_version: null, runs }, null, 2));
    return interrupted.signal.aborted ? 130 : receiptExitCode(runs);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await client.close();
  }
}
