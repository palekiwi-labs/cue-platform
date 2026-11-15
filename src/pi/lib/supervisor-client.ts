/**
 * Pure helpers for delegating through the supervisor: resolving roster
 * agents into supervisor run specs and mapping supervisor results back
 * into delegate receipts. No process, network or filesystem access here.
 */
import type { RunResult } from "../../supervisor/result"
import { type AgentSpec, type RunSpec, THINKING_LEVELS } from "../../supervisor/spec"
import type { BatchReceipt, Roster, RunReceipt } from "./delegate-helpers"

export interface DelegateTask {
  agent: string
  prompt: string
  model?: string
  cwd: string
  worktree?: { base: string }
  systemPrompt?: string
  thinking?: string
}

export interface SupervisorRunState {
  runId: string
  state: "pending" | "running" | "finished" | "derived" | "unknown"
  result: RunResult | null
}

/** Only pi agents can run under the supervisor. */
export function supervisorRoster(roster: Roster): Roster {
  return { ...roster, agents: roster.agents.filter((a) => (a.harness ?? "pi") === "pi") }
}

function thinkingLevel(value: string | null): AgentSpec["thinking"] | undefined {
  return value !== null && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as AgentSpec["thinking"])
    : undefined
}

/** Resolve one task's agent, model alias and allowlist into a run spec. */
export function resolveRun(task: DelegateTask, roster: Roster, context: string): RunSpec {
  const agent = roster.agents.find((a) => a.name === task.agent)
  if (!agent) throw new Error(`unknown agent ${task.agent}`)
  if ((agent.harness ?? "pi") !== "pi") {
    throw new Error(`agent ${task.agent} uses harness ${agent.harness}; the supervisor runs pi only`)
  }
  const alias = task.model ?? agent.models[0]
  if (alias === undefined) throw new Error(`agent ${task.agent} has no default model`)
  if (!agent.models.includes(alias)) {
    throw new Error(`model ${alias} is not allowed for ${task.agent} (allowed: ${agent.models.join(", ")})`)
  }
  const profile = roster.models[alias]
  if (!profile) throw new Error(`model alias ${alias} is not in the registry`)
  if (task.thinking !== undefined && thinkingLevel(task.thinking) === undefined) {
    throw new Error(`thinking ${task.thinking} is not one of ${THINKING_LEVELS.join(", ")}`)
  }
  const thinking = thinkingLevel(task.thinking ?? profile.thinking)
  const systemPrompt = task.systemPrompt ?? agent.systemPrompt
  const spec: AgentSpec = {
    name: agent.name,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(agent.tools != null ? { tools: agent.tools } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(agent.extensions && agent.extensions.length ? { extensions: agent.extensions } : {}),
    ...(agent.isolated ? { isolated: true } : {}),
  }
  return {
    cwd: task.cwd,
    context,
    prompt: task.prompt,
    model: profile.id,
    ...(task.worktree ? { worktree: task.worktree } : {}),
    agent: spec,
  }
}

/** Derive a submit request id from a tool call id; stable across retries. */
export function requestIdFor(toolCallId: string): string {
  const cleaned = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180)
  return `delegate-${cleaned || "call"}`
}

export function isTerminal(run: SupervisorRunState): boolean {
  return run.result !== null || run.state === "unknown"
}

const OUTCOME_LABEL: Record<string, string> = {
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed out",
  cancelled: "cancelled",
  launch_failed: "launch failed",
  unknown: "unknown",
}

/** Map one supervisor run onto the receipt shape delegate already formats. */
export function toReceipt(agent: string, run: SupervisorRunState, durationMs: number, model?: string): RunReceipt {
  const result = run.result
  const outcome = result ? result.outcome : "unknown"
  return {
    agent,
    model: model ?? result?.model ?? null,
    outcome: OUTCOME_LABEL[outcome] ?? outcome,
    exit_code: result?.termination ? Number(result.termination.exitStatus) || null : null,
    duration_ms: durationMs,
    turns: result?.turns ?? 0,
    cost_usd: result?.usage.cost ?? 0,
    response: result?.text ?? "",
    error: result ? result.error : "no result recorded; outcome unknown",
    stderr_excerpt: null,
    trace: null,
    trace_error: null,
  }
}

export function toBatchReceipt(
  batchId: string,
  agents: string[],
  runs: SupervisorRunState[],
  durationMs: number,
  models: string[] = [],
): BatchReceipt {
  return {
    batch_id: batchId,
    runs: runs.map((run, i) => toReceipt(agents[i] ?? "agent", run, durationMs, models[i])),
  }
}

/** Text returned for a background submission. */
export function formatBackgroundSubmission(batchId: string, runIds: string[], agents: string[]): string {
  return [
    `Submitted batch ${batchId} to the supervisor; it runs without you.`,
    ...runIds.map((id, i) => `- ${agents[i] ?? "agent"}: ${id}`),
    "",
    "Check on it with delegate-status (status, result or cancel) and this batch id.",
  ].join("\n")
}
