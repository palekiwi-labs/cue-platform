/**
 * Translation between cue-agent batch specs and receipts and the
 * supervisor, so callers written against `cue-agent run --json --spec`
 * can run on the supervisor unchanged. Pure: no process, network or
 * filesystem access.
 */
import type { RunSpec } from "../../supervisor/spec"
import type { Roster } from "./delegate-helpers"
import { type DelegateTask, type SupervisorRunState, resolveRun } from "./supervisor-client"

export class CompatSpecError extends Error {}

const TASK_FIELDS = new Set(["agent", "prompt", "label", "cwd", "context", "worktree", "model", "thinking", "system_prompt", "env"])
const TOP_FIELDS = new Set(["label", "job", "defaults", "tasks"])

export interface TranslatedBatch {
  runs: RunSpec[]
  agents: string[]
  labels: (string | null)[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(fields: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.length === 0) throw new CompatSpecError(`${at}.${key} must be a non-empty string`)
  return value
}

function worktreeOf(fields: Record<string, unknown>, at: string): { base: string } | undefined {
  const value = fields.worktree
  if (value === undefined || value === null || value === false) return undefined
  if (value === true) return { base: "HEAD" }
  if (!isRecord(value)) throw new CompatSpecError(`${at}.worktree must be an object`)
  if (value.path !== undefined || value.branch !== undefined) {
    throw new CompatSpecError(`${at}.worktree: path and branch are not supported by the supervisor`)
  }
  const base = optionalString(value, "base", `${at}.worktree`)
  return { base: base ?? "HEAD" }
}

function checkFields(fields: Record<string, unknown>, at: string): void {
  const unknown = Object.keys(fields).filter((key) => !TASK_FIELDS.has(key))
  if (unknown.length) throw new CompatSpecError(`${at}: unsupported fields: ${unknown.join(", ")}`)
}

/**
 * Translate a cue-agent batch spec into supervisor runs. `env` is accepted
 * but only CUE_CONTEXT is honoured, through the run's context; `job` is
 * dropped. Fields the supervisor cannot honour are rejected.
 */
export function fromCueAgentSpec(raw: unknown, roster: Roster): TranslatedBatch {
  if (!isRecord(raw)) throw new CompatSpecError("spec must be an object")
  const extra = Object.keys(raw).filter((key) => !TOP_FIELDS.has(key))
  if (extra.length) throw new CompatSpecError(`spec: unsupported fields: ${extra.join(", ")}`)
  const defaults = raw.defaults === undefined ? {} : raw.defaults
  if (!isRecord(defaults)) throw new CompatSpecError("defaults must be an object")
  checkFields(defaults, "defaults")
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new CompatSpecError("tasks must be a non-empty list")

  const translated: TranslatedBatch = { runs: [], agents: [], labels: [] }
  raw.tasks.forEach((value, index) => {
    const at = `tasks[${index}]`
    if (!isRecord(value)) throw new CompatSpecError(`${at} must be an object`)
    checkFields(value, at)
    const fields = { ...defaults, ...value }
    const agent = optionalString(fields, "agent", at)
    const prompt = fields.prompt
    if (agent === undefined) throw new CompatSpecError(`${at}: missing agent`)
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new CompatSpecError(`${at}.prompt must be a non-empty string`)
    }
    const cwd = optionalString(fields, "cwd", at)
    if (cwd === undefined) throw new CompatSpecError(`${at}: missing cwd`)
    const context = optionalString(fields, "context", at)
    if (context === undefined) throw new CompatSpecError(`${at}: missing context`)
    const task: DelegateTask = {
      agent,
      prompt,
      cwd,
      model: optionalString(fields, "model", at),
      worktree: worktreeOf(fields, at),
      systemPrompt: optionalString(fields, "system_prompt", at),
      thinking: optionalString(fields, "thinking", at),
    }
    try {
      translated.runs.push(resolveRun(task, roster, context))
    } catch (error) {
      throw new CompatSpecError(`${at}: ${(error as Error).message}`)
    }
    translated.agents.push(agent)
    translated.labels.push(optionalString(fields, "label", at) ?? null)
  })
  return translated
}

const OUTCOMES: Record<string, string> = {
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "aborted",
  launch_failed: "failed",
  unknown: "unknown",
}

export interface RunTiming {
  startedAt: number | null
  finishedAt: number | null
}

/** One run in cue-agent receipt shape; fields the supervisor lacks are null. */
export function toCueAgentRun(
  batchId: string,
  agent: string,
  label: string | null,
  state: SupervisorRunState,
  runPath: string,
  timing: RunTiming,
) {
  const result = state.result
  const outcome = result ? result.outcome : "unknown"
  const exit = result?.termination ? Number(result.termination.exitStatus) : NaN
  return {
    run_id: state.runId,
    batch_id: batchId,
    agent,
    label,
    model: result?.model ?? null,
    outcome: OUTCOMES[outcome] ?? outcome,
    exit_code: Number.isInteger(exit) ? exit : null,
    signal: null,
    duration_ms:
      timing.startedAt !== null && timing.finishedAt !== null ? Math.max(0, timing.finishedAt - timing.startedAt) : null,
    turns: result?.turns ?? 0,
    tokens_input: result?.usage.input ?? 0,
    tokens_output: result?.usage.output ?? 0,
    cost_usd: result?.usage.cost ?? 0,
    response: result?.text ?? null,
    error: result ? result.error : "no result recorded; outcome unknown",
    events_malformed: result?.ignoredLines ?? null,
    events_oversized: null,
    events_truncated: null,
    persistence_errors: [],
    cleanup_errors: [],
    run_path: runPath,
  }
}

export type CueAgentRun = ReturnType<typeof toCueAgentRun>

export function receiptExitCode(runs: CueAgentRun[]): number {
  return runs.every((run) => run.outcome === "succeeded") ? 0 : 1
}
