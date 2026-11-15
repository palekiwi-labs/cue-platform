import { describe, expect, test } from "bun:test"
import type { RunResult } from "../../supervisor/result"
import { CompatSpecError, fromCueAgentSpec, receiptExitCode, toCueAgentRun } from "./cue-agent-compat"
import { parseAgentList } from "./delegate-helpers"

const roster = parseAgentList(
  JSON.stringify({
    models: { opus: { id: "anthropic/claude-opus", thinking: "medium" }, flash: { id: "google/flash", thinking: "low" } },
    agents: [{ name: "reviewer", harness: "pi", models: ["opus", "flash"], system_prompt: "Review.", tools: ["read"] }],
  }),
)

const reviewSpec = {
  label: "review-1-reviewers",
  job: { id: "1", label: "x" },
  defaults: {
    cwd: "/repo",
    worktree: { base: "abc123", ephemeral: true },
    context: "o/r/ctx",
    env: { CUE_CONTEXT: "ctx" },
  },
  tasks: [
    { agent: "reviewer", prompt: "look", label: "reviewers-opus", model: "opus" },
    { agent: "reviewer", prompt: "look", label: "reviewers-flash", model: "flash", thinking: "high", system_prompt: "S." },
  ],
}

describe("fromCueAgentSpec", () => {
  test("translates the cue-review phase spec shape", () => {
    const batch = fromCueAgentSpec(reviewSpec, roster)
    expect(batch.agents).toEqual(["reviewer", "reviewer"])
    expect(batch.labels).toEqual(["reviewers-opus", "reviewers-flash"])
    expect(batch.runs[0]).toEqual({
      cwd: "/repo",
      context: "o/r/ctx",
      prompt: "look",
      model: "anthropic/claude-opus",
      worktree: { base: "abc123" },
      agent: { name: "reviewer", systemPrompt: "Review.", tools: ["read"], thinking: "medium" },
    })
    expect(batch.runs[1].agent).toMatchObject({ systemPrompt: "S.", thinking: "high" })
  })

  test("rejects what the supervisor cannot honour", () => {
    const bad = (patch: object) => () => fromCueAgentSpec({ ...reviewSpec, ...patch }, roster)
    expect(bad({ tasks: [{ agent: "reviewer", prompt: "x", tools: ["read"] }] })).toThrow(CompatSpecError)
    expect(bad({ tasks: [{ agent: "reviewer", prompt: { file: "p.md" } }] })).toThrow("prompt")
    expect(bad({ tasks: [{ agent: "reviewer", prompt: "x", model: "sol" }] })).toThrow("tasks[0]: model sol")
    expect(bad({ defaults: { cwd: "/repo" }, tasks: [{ agent: "reviewer", prompt: "x" }] })).toThrow("missing context")
    expect(bad({ timeout: 5 })).toThrow("unsupported fields: timeout")
  })
})

function result(outcome: RunResult["outcome"]): RunResult {
  return {
    outcome,
    partial: false,
    text: "done",
    stopReason: "stop",
    error: null,
    model: "google/flash",
    turns: 3,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01 },
    ignoredLines: 0,
    termination: { serviceResult: "success", exitCode: "exited", exitStatus: "0", finalizedAt: 5_000 },
    cancel: null,
  }
}

describe("toCueAgentRun", () => {
  test("maps a result onto cue-agent receipt fields", () => {
    const run = toCueAgentRun("b", "reviewer", "l", { runId: "r", state: "derived", result: result("succeeded") }, "/s/runs/r", {
      startedAt: 1_000,
      finishedAt: 5_000,
    })
    expect(run).toMatchObject({
      run_id: "r",
      batch_id: "b",
      outcome: "succeeded",
      exit_code: 0,
      duration_ms: 4_000,
      turns: 3,
      tokens_input: 10,
      tokens_output: 5,
      cost_usd: 0.01,
      run_path: "/s/runs/r",
    })
    expect(receiptExitCode([run])).toBe(0)
  })

  test("cancelled becomes aborted and a missing result is unknown", () => {
    const timing = { startedAt: null, finishedAt: null }
    const cancelled = toCueAgentRun("b", "a", null, { runId: "r", state: "derived", result: result("cancelled") }, "/p", timing)
    const missing = toCueAgentRun("b", "a", null, { runId: "r", state: "unknown", result: null }, "/p", timing)
    expect(cancelled.outcome).toBe("aborted")
    expect(missing).toMatchObject({ outcome: "unknown", duration_ms: null, exit_code: null })
    expect(receiptExitCode([cancelled, missing])).toBe(1)
  })
})
