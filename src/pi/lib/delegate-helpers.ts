/**
 * Pure helpers for the `delegate` tool: parsing cue-agent's JSON output,
 * building the model-facing tool description, and formatting batch
 * receipts for the calling agent. No process or filesystem access here.
 */

/** Per-call task cap enforced by cue-agent (no queue). */
export const MAX_TASKS = 4

export interface AgentInfo {
  name: string
  description: string | null
  /** Ordered model allowlist (registry aliases); first is the default. */
  models: string[]
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
    '- "consult opus and flash" -> two tasks, agent consultant, model',
    "  opus and model flash (same prompt).",
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
      if (run.outcome === "completed") {
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
