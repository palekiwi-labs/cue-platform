import { describe, expect, test } from "bun:test"
import { parseBatchSpec } from "../../supervisor/spec"
import { parseAgentList } from "./delegate-helpers"
import { isTerminal, requestIdFor, resolveRun, supervisorRoster, toReceipt } from "./supervisor-client"

const roster = parseAgentList(
  JSON.stringify({
    models: {
      opus: { id: "anthropic/claude-opus", thinking: "medium", provider: "anthropic" },
      flash: { id: "google/flash", thinking: "low" },
      bare: { id: "x/bare" },
    },
    agents: [
      {
        name: "reviewer",
        harness: "pi",
        models: ["opus", "flash", "bare"],
        system_prompt: "Review.",
        tools: ["read", "grep"],
        extensions: [],
        isolated: false,
      },
      { name: "summarizer", harness: "pi", models: ["flash"], tools: [], extensions: ["/ext.ts"], isolated: true },
      { name: "claude", harness: "claude-code", models: ["opus"] },
    ],
  }),
)

const task = { agent: "reviewer", prompt: "look", cwd: "/repo" }

describe("supervisorRoster", () => {
  test("keeps only pi agents", () => {
    expect(supervisorRoster(roster).agents.map((a) => a.name)).toEqual(["reviewer", "summarizer"])
  })
})

describe("resolveRun", () => {
  test("uses the default model and its profile thinking", () => {
    expect(resolveRun(task, roster, "o/r/ctx")).toEqual({
      cwd: "/repo",
      context: "o/r/ctx",
      prompt: "look",
      model: "anthropic/claude-opus",
      agent: { name: "reviewer", systemPrompt: "Review.", tools: ["read", "grep"], thinking: "medium" },
    })
  })

  test("an override picks that alias, its thinking and keeps the worktree", () => {
    const run = resolveRun({ ...task, model: "flash", worktree: { base: "abc" } }, roster, "c")
    expect(run.model).toBe("google/flash")
    expect(run.agent?.thinking).toBe("low")
    expect(run.worktree).toEqual({ base: "abc" })
  })

  test("an alias without thinking omits it", () => {
    expect(resolveRun({ ...task, model: "bare" }, roster, "c").agent?.thinking).toBeUndefined()
  })

  test("task overrides replace system prompt and thinking", () => {
    const run = resolveRun({ ...task, systemPrompt: "Other.", thinking: "high" }, roster, "c")
    expect(run.agent?.systemPrompt).toBe("Other.")
    expect(run.agent?.thinking).toBe("high")
    expect(() => resolveRun({ ...task, thinking: "huge" }, roster, "c")).toThrow("thinking huge")
  })

  test("isolation, extensions and an empty tool list carry through", () => {
    expect(resolveRun({ ...task, agent: "summarizer" }, roster, "c").agent).toEqual({
      name: "summarizer",
      tools: [],
      thinking: "low",
      extensions: ["/ext.ts"],
      isolated: true,
    })
  })

  test("the resolved spec passes supervisor validation", () => {
    expect(() => parseBatchSpec({ runs: [resolveRun(task, roster, "c")] })).not.toThrow()
  })

  test("rejects unknown agents, other harnesses and disallowed models", () => {
    expect(() => resolveRun({ ...task, agent: "nope" }, roster, "c")).toThrow("unknown agent")
    expect(() => resolveRun({ ...task, agent: "claude" }, roster, "c")).toThrow("pi only")
    expect(() => resolveRun({ ...task, model: "sol" }, roster, "c")).toThrow("not allowed")
  })
})

describe("requestIdFor", () => {
  test("is stable and within the supervisor id charset", () => {
    const id = requestIdFor("toolu_01:abc/def")
    expect(id).toBe(requestIdFor("toolu_01:abc/def"))
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,200}$/)
  })
})

describe("receipts", () => {
  const result = {
    outcome: "succeeded" as const,
    partial: false,
    text: "done",
    stopReason: "stop",
    error: null,
    model: "google/flash",
    turns: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.01 },
    ignoredLines: 0,
    termination: { serviceResult: "success", exitCode: "exited", exitStatus: "0", finalizedAt: 1 },
    cancel: null,
  }

  test("a succeeded run keeps the supervisor outcome and its response", () => {
    const receipt = toReceipt("reviewer", { runId: "r", state: "derived", result }, 5)
    expect(receipt).toMatchObject({ outcome: "succeeded", response: "done", turns: 2, cost_usd: 0.01 })
  })

  test("a recorded result or an unknown run is terminal", () => {
    expect(isTerminal({ runId: "r", state: "running", result: null })).toBe(false)
    expect(isTerminal({ runId: "r", state: "finished", result })).toBe(true)
    expect(isTerminal({ runId: "r", state: "derived", result })).toBe(true)
    expect(isTerminal({ runId: "r", state: "unknown", result: null })).toBe(true)
  })
})
