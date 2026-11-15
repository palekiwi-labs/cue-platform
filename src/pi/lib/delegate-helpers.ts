/**
 * Pure helpers for the `delegate` tool: parsing cue-agent's JSON output,
 * building the model-facing tool description, and formatting batch
 * receipts for the calling agent. No process or filesystem access here.
 */

import { resolve } from "node:path"
import { type TaskEnv, withAgentName } from "./agent-env"

/** Per-call task cap enforced by cue-agent (no queue). */
export const MAX_TASKS = 4

export interface AgentInfo {
  name: string
  description: string | null
  /** Ordered model allowlist (registry aliases); first is the default. */
  models: string[]
  harness?: string
  systemPrompt?: string | null
  tools?: string[] | null
  extensions?: string[]
  isolated?: boolean
}

export interface ModelProfile {
  id: string
  thinking: string | null
  provider: string | null
}

export interface Roster {
  agents: AgentInfo[]
  /** The model alias registry, keyed by alias. */
  models: Record<string, ModelProfile>
}

export interface RunReceipt {
  agent: string
  model: string | null
  outcome: string
  exit_code: number | null
  duration_ms: number
  turns: number
  cost_usd: number
  response: string
  error: string | null
  stderr_excerpt: string | null
  trace: string | null
  trace_error: string | null
}

export interface BatchReceipt {
  batch_id: string
  runs: RunReceipt[]
}

/** Parse `cue-agent agents list --json` output into the roster. */
export function parseAgentList(stdout: string): Roster {
  const parsed = JSON.parse(stdout) as { agents?: unknown; models?: unknown }
  if (!Array.isArray(parsed.agents)) {
    throw new Error("cue-agent agents list: missing 'agents' array")
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null)
  const agents = parsed.agents.map((raw) => {
    const a = raw as Record<string, unknown>
    return {
      name: String(a.name),
      description: str(a.description),
      models: Array.isArray(a.models) ? a.models.map(String) : [],
      harness: str(a.harness) ?? "pi",
      systemPrompt: str(a.system_prompt),
      tools: Array.isArray(a.tools) ? a.tools.map(String) : null,
      extensions: Array.isArray(a.extensions) ? a.extensions.map(String) : [],
      isolated: a.isolated === true,
    }
  })
  const models: Record<string, ModelProfile> = {}
  const registry = (parsed.models ?? {}) as Record<string, Record<string, unknown>>
  for (const [alias, p] of Object.entries(registry)) {
    models[alias] = { id: String(p.id), thinking: str(p.thinking), provider: str(p.provider) }
  }
  return { agents, models }
}

/** Every alias some agent allows, in registry order. */
export function selectableAliases(roster: Roster): string[] {
  const used = new Set(roster.agents.flatMap((a) => a.models))
  return Object.keys(roster.models).filter((m) => used.has(m))
}

/** Map a full model ID back to its registry alias (for receipts). */
export function aliasFor(roster: Roster, id: string | null): string | null {
  if (!id) return null
  const hit = Object.entries(roster.models).find(([, p]) => p.id === id)
  return hit ? hit[0] : id
}

/**
 * Resolve the two prompt levels into one prompt per task: a task prompt
 * replaces the batch prompt, never appends. Throws retryable errors when a
 * task is left without a prompt, or when a batch prompt is fully shadowed.
 */
export function resolvePrompts(
  batch: string | null,
  tasks: (string | null)[],
): { defaults: string | null; prompts: string[] } {
  const missing = tasks
    .map((p, i) => (p === null ? i + 1 : null))
    .filter((n): n is number => n !== null)
  if (missing.length > 0 && batch === null) {
    throw new Error(
      `task${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ` +
        "ha" + (missing.length > 1 ? "ve" : "s") +
        " no prompt and no top-level prompt was given; put the full " +
        "instructions in the top-level prompt.",
    )
  }
  if (batch !== null && tasks.every((p) => p !== null)) {
    throw new Error(
      "every task overrides the top-level prompt, so it is unused; " +
        "keep the shared instructions in the top-level prompt and drop " +
        "the per-task prompts, or remove the top-level prompt.",
    )
  }
  return {
    defaults: batch,
    prompts: tasks.map((p) => p ?? (batch as string)),
  }
}

const PLACEHOLDER_WRAPPERS = [/^<.+>$/, /^\{\{.+\}\}$/, /^\[.+\]$/, /^\$.+$/]
const PLACEHOLDER_WORDS = new Set(["tbd", "todo", "...", "…"])
const REFERENCE_STARTS = [
  "same as above",
  "same as before",
  "see above",
  "as above",
  "as discussed",
  "same prompt as",
]
const MIN_WORDS = 8

/**
 * Detect a prompt that is an unfilled placeholder or a reference instead of
 * a self-contained brief. Returns the offending token (for the error) or
 * null when the prompt looks like real instructions.
 */
export function placeholderPrompt(prompt: string): string | null {
  const s = prompt.trim()
  if (s.length === 0) return s
  if (PLACEHOLDER_WORDS.has(s.toLowerCase())) return s
  if (!/\s/.test(s) && /^[A-Z0-9_-]{4,}$/.test(s)) return s
  if (!/\s/.test(s) && PLACEHOLDER_WRAPPERS.some((re) => re.test(s))) return s
  const lower = s.toLowerCase()
  if (REFERENCE_STARTS.some((p) => lower.startsWith(p))) return s
  if (s.split(/\s+/).length < MIN_WORDS) return s
  return null
}

export interface BatchTaskSpec {
  agent: string
  prompt?: string
  cwd?: string
  worktree?: { base: string; ephemeral: boolean }
  model?: string
  context?: string
  env: TaskEnv
}

export interface BatchSpec {
  defaults?: { prompt: string }
  tasks: BatchTaskSpec[]
}

/**
 * Build the cue-agent run spec: the batch prompt rides the `defaults`
 * layer; a task carries its own prompt only when it differs from the
 * default (cue-agent resolves inheritance itself). Also validates that
 * no resolved prompt is a placeholder.
 */
export function buildBatchSpec(
  args: {
    prompt?: string | null
    tasks: Array<{
      agent: string
      prompt?: string | null
      model?: string
      dir?: string
      worktree?: true | { base: string }
      context?: string | null
    }>
  },
  cwd: string,
): BatchSpec {
  const { defaults, prompts } = resolvePrompts(
    args.prompt ?? null,
    args.tasks.map((t) => t.prompt ?? null),
  )
  for (const p of prompts) {
    const hit = placeholderPrompt(p)
    if (hit) {
      throw new Error(
        `a task prompt resolved to "${hit}", which looks like an ` +
          "unfilled placeholder. Rewrite the delegate call with the " +
          "complete instructions written out in full.",
      )
    }
  }
  const toWorktree = (w: true | { base: string }) =>
    w === true
      ? { base: "HEAD", ephemeral: true }
      : { base: w.base, ephemeral: true }
  return {
    ...(defaults ? { defaults: { prompt: defaults } } : {}),
    tasks: args.tasks.map((t, i) =>
      withAgentName({
        agent: t.agent,
        ...(prompts[i] !== defaults ? { prompt: prompts[i] as string } : {}),
        ...(t.worktree
          ? { worktree: toWorktree(t.worktree) }
          : { cwd: t.dir ? resolve(cwd, t.dir) : cwd }),
        ...(t.model ? { model: t.model } : {}),
        ...(t.context ? { context: t.context } : {}),
      }),
    ),
  }
}

/** The tool description: what it does, when to use it, and the roster. */
export function buildDescription(roster: Roster): string {
  const { agents, models } = roster
  const roster_ = agents.length
    ? agents
        .map((a) => {
          const ms = a.models.length
            ? ` [${a.models.map((m, i) => (i === 0 ? `${m}*` : m)).join(", ")}]`
            : " [harness default; no model override]"
          const desc = a.description ? `: ${a.description}` : ""
          return `- ${a.name}${ms}${desc}`
        })
        .join("\n")
    : "- (none configured; define agents in ~/.config/cue/cue-agent.json)"
  const registry = Object.entries(models)
    .map(([alias, p]) => {
      const extra = [p.provider, p.thinking && `thinking ${p.thinking}`].filter(Boolean).join(", ")
      return `- ${alias}: ${p.id}${extra ? ` (${extra})` : ""}`
    })
    .join("\n")

  return [
    "Delegate work to named agents that run as separate pi processes.",
    "Each agent starts from scratch: it does NOT see this conversation,",
    "so every prompt must be self-contained (goal, relevant paths and",
    "facts, and what to return). Up to " + MAX_TASKS + " tasks run in",
    "parallel per call; the call returns when all have finished.",
    "",
    'Use it when the user says "delegate to <agent>", "ask <agent> to ...",',
    '"consult <agent>", or names a model. Also use it to keep your own',
    "context small: hand off broad searches or second opinions and keep",
    "only the answer.",
    "",
    "Agents (models in brackets are the aliases each agent allows; * marks",
    "its default, used when a task sets no model):",
    roster_,
    "",
    "Model aliases:",
    registry || "- (none)",
    "",
    "Choosing agent and model:",
    '- "ask explore ..." -> one task, agent explore, no model (default).',
    '"consult opus and flash" -> one top-level prompt with the full brief,',
    "plus two tasks that differ only in model (no per-task prompt).",
    '- "code review from reviewer opus" -> agent reviewer, model opus.',
    '- "ask opus" with no agent named -> the agent whose role fits the',
    "  request and that allows opus.",
    "A model must be in the agent's allowlist; otherwise the whole call",
    "is rejected with the allowed aliases, so fix the task and retry.",
    "",
    "Per task, set worktree: true to run the agent in a throwaway git",
    "worktree of the session repo at its current HEAD, deleted when the",
    "task finishes — use it when the agent inspects source while the",
    "operator keeps editing the branch (e.g. code reviews).",
  ].join("\n")
}

/** Job id for a background batch: a safe path segment, unique per launch. */
export function backgroundJobId(now: Date = new Date(), rand: string = Math.random().toString(16).slice(2, 8)): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14)
  return `delegate-${stamp}-${rand}`
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Shell command for a background batch window: runs the spec under the
 * direnv environment of cwd, writing the receipt and stderr into dir.
 */
export function backgroundCommand(binary: string, specPath: string, dir: string, cwd: string): string {
  return (
    `direnv exec ${shellQuote(cwd)} ${binary} run --spec ${shellQuote(specPath)} --json` +
    ` > ${shellQuote(`${dir}/receipt.json`)} 2> ${shellQuote(`${dir}/stderr.log`)}`
  )
}

/** What the caller needs to find a background batch again. */
export function formatBackgroundHandle(jobId: string, dir: string): string {
  return [
    `Started in the background as job ${jobId}; continue with other work.`,
    "",
    "Check on it with cue-agent:",
    `- cue-agent ps --all --job ${jobId} --json   (batch id, state)`,
    "- cue-agent status <batch_id>   (per-run outcome)",
    "- cue-agent logs <batch_id>     (events)",
    "- cue-agent stop <batch_id>     (cancel)",
    "",
    `Receipt and stderr: ${dir}/receipt.json, ${dir}/stderr.log`,
  ].join("\n")
}

function formatDuration(ms: number): string {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** Format a batch receipt as markdown sections for the calling model. */
export function formatReceipt(batch: BatchReceipt, roster?: Roster): string {
  return batch.runs
    .map((run) => {
      const stats = [
        `${run.turns} turns`,
        formatDuration(run.duration_ms),
        `$${run.cost_usd.toFixed(4)}`,
      ].join(", ")
      const model = roster ? aliasFor(roster, run.model) : run.model
      const who = model ? `${run.agent}@${model}` : run.agent
      const lines = [`## ${who} - ${run.outcome} (${stats})`, ""]
      if (run.outcome === "completed" || run.outcome === "succeeded") {
        lines.push(run.response.trim() || "(empty response)")
      } else {
        if (run.error) lines.push(`error: ${run.error}`)
        if (run.stderr_excerpt) lines.push("stderr:", run.stderr_excerpt.trim())
        if (run.response.trim()) lines.push("", "partial response:", run.response.trim())
      }
      if (run.trace) lines.push("", `trace: ${run.trace}`)
      if (run.trace_error) lines.push("", `trace error: ${run.trace_error}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

const LABEL_WORDS = 6

/**
 * Batch label for the agent monitor: the distinct agents, then the first
 * words of the first prompt.
 */
export function batchLabel(tasks: { agent: string; prompt: string }[]): string {
  const agents = [...new Set(tasks.map((t) => t.agent))].join("+")
  const words = (tasks[0]?.prompt ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return agents
  const head = words.slice(0, LABEL_WORDS).join(" ")
  return `${agents}: ${head}${words.length > LABEL_WORDS ? "…" : ""}`
}
