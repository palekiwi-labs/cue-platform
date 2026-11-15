import { readFileSync } from "node:fs";
import { cancel } from "./cancel";
import { reconcileLoop } from "./daemon";
import { finalize } from "./finalize";
import { reconcile } from "./reconcile";
import { serveNats } from "./nats";
import { launchBatch, waitForResults } from "./run";
import { parseBatchSpec, SpecError } from "./spec";
import { stateRoot } from "./store";
import { submitCommand } from "./submit";

const USAGE =
  "usage: cue-supervisor run [--detach] <spec.json> | submit --wait --spec <cue-agent-spec.json> | cancel run|batch <id> | daemon | reconcile | finalize <run-dir>";

function which(name: string): string {
  const path = Bun.which(name);
  if (path === null) throw new Error(`${name} not found on PATH`);
  return path;
}

async function run(specPath: string, detach: boolean): Promise<number> {
  let spec;
  try {
    spec = parseBatchSpec(JSON.parse(readFileSync(specPath, "utf8")));
  } catch (error) {
    if (error instanceof SpecError || error instanceof SyntaxError) {
      console.error(`invalid spec: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const batch = launchBatch(spec, {
    root: stateRoot(),
    piPath: process.env.CUE_SUPERVISOR_PI ?? which("pi"),
    shPath: which("sh"),
    finalizeCommand: (runDir) => [process.execPath, import.meta.path, "finalize", runDir],
    env: process.env,
  });
  console.error(`batch ${batch.batchId}: ${batch.runs.map((r) => r.runId).join(" ")}`);
  if (detach) {
    console.log(JSON.stringify({ batchId: batch.batchId, runIds: batch.runs.map((r) => r.runId) }));
    return 0;
  }
  const results = await waitForResults(batch);
  console.log(JSON.stringify({ batchId: batch.batchId, runs: results }, null, 2));
  return results.every((r) => r.result.outcome === "succeeded") ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, arg, extra] = argv;
  if (command === "run" && arg === "--detach" && extra) return run(extra, true);
  if (command === "run" && arg) return run(arg, false);
  if (command === "cancel" && (arg === "run" || arg === "batch") && extra) {
    const target =
      arg === "run" ? { kind: "run" as const, runId: extra } : { kind: "batch" as const, batchId: extra };
    console.log(JSON.stringify(cancel(stateRoot(), target)));
    return 0;
  }
  if (command === "daemon" && arg === undefined) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      await Promise.all([
        serveNats({
          root: stateRoot(),
          piPath: process.env.CUE_SUPERVISOR_PI ?? which("pi"),
          shPath: which("sh"),
          finalizeCommand: (runDir) => [process.execPath, import.meta.path, "finalize", runDir],
          env: process.env,
        }, controller.signal),
        reconcileLoop(stateRoot(), {
          signal: controller.signal,
          intervalMs: Number(process.env.CUE_SUPERVISOR_RECONCILE_MS ?? 5_000),
          report: (states) => console.log(JSON.stringify({ reconciliation: states })),
        }),
      ]);
    } finally {
      controller.abort();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    return 0;
  }
  if (command === "submit" && arg === "--wait" && extra === "--spec" && argv[3] && argv.length === 4) {
    return submitCommand(argv[3]);
  }
  if (command === "reconcile") {
    console.log(JSON.stringify(reconcile(stateRoot()), null, 2));
    return 0;
  }
  if (command === "finalize" && arg) {
    finalize(arg);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
