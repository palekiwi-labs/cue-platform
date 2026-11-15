import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cancel, type CancelTarget } from "./cancel";
import { reconcile } from "./reconcile";
import { launchBatch, type LaunchEnvironment } from "./run";
import { parseBatchSpec } from "./spec";
import { batchesDir, readJsonIfExists, runsDir } from "./store";

export const API_PREFIX = "agent.supervisor.v1";
export const HEARTBEAT_BUCKET = "supervisors";
export const HEARTBEAT_KEY = "supervisor";
export const HEARTBEAT_TTL_MS = 15_000;

interface BatchRecord {
  batchId: string;
  runIds: string[];
  requestId?: string;
  payload?: string;
}

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new ApiError("invalid_request", "invalid id");
  }
  return value;
}

function target(value: Record<string, unknown>): CancelTarget {
  if (value.kind === "run") return { kind: "run", runId: id(value.runId) };
  if (value.kind === "batch") return { kind: "batch", batchId: id(value.batchId) };
  throw new ApiError("invalid_request", "kind must be run or batch");
}

export function handleRequest(operation: string, input: unknown, env: LaunchEnvironment): unknown {
  const value = object(input);
  if (operation === "submit") {
    const requestId = id(value.requestId);
    const spec = parseBatchSpec(value.spec);
    const payload = JSON.stringify(spec);
    const dir = batchesDir(env.root);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const batch = readJsonIfExists<BatchRecord>(join(dir, file))!;
        if (batch.requestId !== requestId) continue;
        if (batch.payload !== payload) throw new ApiError("conflict", "requestId has a different payload");
        return { batchId: batch.batchId, runIds: batch.runIds };
      }
    }
    const batch = launchBatch(spec, env, { requestId, payload });
    return { batchId: batch.batchId, runIds: batch.runs.map((run) => run.runId) };
  }
  if (!["cancel", "status", "result"].includes(operation)) {
    throw new ApiError("invalid_request", "unknown operation");
  }
  const selected = target(value);
  const runIds = selected.kind === "run" ? [selected.runId] :
    readJsonIfExists<BatchRecord>(join(batchesDir(env.root), `${selected.batchId}.json`))?.runIds;
  if (!runIds || runIds.some((runId) => !existsSync(join(runsDir(env.root), runId, "run.json")))) {
    throw new ApiError("not_found", "unknown target");
  }
  if (operation === "cancel") return cancel(env.root, selected);
  const states = reconcile(env.root);
  return { runs: runIds.map((runId) => ({
    runId,
    state: states[runId],
    result: readJsonIfExists(join(runsDir(env.root), runId, "result.json")),
    cleanup: readJsonIfExists(join(runsDir(env.root), runId, "cleanup.json")),
  })) };
}

export function apiReply(operation: string, input: unknown, env: LaunchEnvironment): unknown {
  try {
    return { ok: true, data: handleRequest(operation, input, env) };
  } catch (error) {
    return { ok: false, error: {
      code: error instanceof ApiError ? error.code : "request_failed",
      message: error instanceof Error ? error.message : String(error),
    } };
  }
}
