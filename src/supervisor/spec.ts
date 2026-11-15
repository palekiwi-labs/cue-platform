import { isAbsolute } from "node:path";

export interface RunSpec {
  cwd: string;
  context: string;
  prompt: string;
  model?: string;
  timeoutSec?: number;
  worktree?: { base: string };
}

export interface BatchSpec {
  runs: RunSpec[];
}

export class SpecError extends Error {}

function fail(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

function parseRun(value: unknown, path: string): RunSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const run = value as Record<string, unknown>;
  const known = new Set(["cwd", "context", "prompt", "model", "timeoutSec", "worktree"]);
  for (const key of Object.keys(run)) if (!known.has(key)) fail(path, `unknown field ${key}`);
  if (typeof run.cwd !== "string" || !isAbsolute(run.cwd)) fail(`${path}.cwd`, "must be an absolute path");
  if (typeof run.context !== "string" || run.context === "") fail(`${path}.context`, "must be a non-empty string");
  if (typeof run.prompt !== "string" || run.prompt === "") fail(`${path}.prompt`, "must be a non-empty string");
  if (run.model !== undefined && (typeof run.model !== "string" || run.model === "")) {
    fail(`${path}.model`, "must be a non-empty string");
  }
  if (
    run.timeoutSec !== undefined &&
    (typeof run.timeoutSec !== "number" || !Number.isInteger(run.timeoutSec) || run.timeoutSec <= 0)
  ) {
    fail(`${path}.timeoutSec`, "must be a positive integer");
  }
  let worktree: RunSpec["worktree"];
  if (run.worktree !== undefined && run.worktree !== false) {
    if (run.worktree === true) worktree = { base: "HEAD" };
    else {
      const value = run.worktree as Record<string, unknown>;
      if (typeof value !== "object" || value === null || Array.isArray(value) ||
          typeof value.base !== "string" || value.base === "" || Object.keys(value).some((key) => key !== "base")) {
        fail(`${path}.worktree`, "must be a boolean or { base: non-empty string }");
      }
      worktree = { base: value.base as string };
    }
  }
  return {
    cwd: run.cwd,
    context: run.context,
    prompt: run.prompt,
    ...(worktree !== undefined ? { worktree } : {}),
    ...(run.model !== undefined ? { model: run.model as string } : {}),
    ...(run.timeoutSec !== undefined ? { timeoutSec: run.timeoutSec as number } : {}),
  };
}

/** Validates a whole batch spec; throws SpecError on the first problem. */
export function parseBatchSpec(value: unknown): BatchSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("spec", "must be an object");
  const runs = (value as Record<string, unknown>).runs;
  if (!Array.isArray(runs) || runs.length === 0) fail("spec.runs", "must be a non-empty array");
  return { runs: runs.map((run, index) => parseRun(run, `spec.runs[${index}]`)) };
}
