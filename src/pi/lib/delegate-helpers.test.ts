import { describe, expect, test } from "bun:test"
import { buildDescription, formatReceipt, parseAgentList, selectableAliases } from "./delegate-helpers"

const listing = JSON.stringify({
  models: {
    opus: { id: "anthropic/claude-opus", thinking: "medium", provider: "anthropic" },
    flash: { id: "google/flash", provider: "google" },
    unused: { id: "x/unused" },
  },
  agents: [
    { name: "reviewer", description: "reviews", models: ["opus", "flash"], model: "anthropic/claude-opus" },
    { name: "plain", description: null, models: [] },
  ],
})

describe("parseAgentList", () => {
  test("extracts agents with allowlists and the alias registry", () => {
    const r = parseAgentList(listing)
    expect(r.agents[0]).toEqual({ name: "reviewer", description: "reviews", models: ["opus", "flash"] })
    expect(r.models.flash).toEqual({ id: "google/flash", thinking: null, provider: "google" })
  })

  test("rejects output without an agents array", () => {
    expect(() => parseAgentList("{}")).toThrow()
  })

  test("selectable aliases are those some agent allows", () => {
    expect(selectableAliases(parseAgentList(listing))).toEqual(["opus", "flash"])
  })
})

describe("buildDescription", () => {
  test("marks the default model and lists the registry", () => {
    const d = buildDescription(parseAgentList(listing))
    expect(d).toContain("- reviewer [opus*, flash]: reviews")
    expect(d).toContain("- plain [harness default; no model override]")
    expect(d).toContain("- opus: anthropic/claude-opus (anthropic, thinking medium)")
    expect(d).toContain("does NOT see this conversation")
  })
})

describe("formatReceipt", () => {
  const base = {
    model: null,
    exit_code: 0,
    duration_ms: 41000,
    turns: 6,
    cost_usd: 0.004,
    stderr_excerpt: null,
    trace: null,
    trace_error: null,
  }

  test("completed run shows response verbatim", () => {
    const text = formatReceipt({
      batch_id: "b",
      runs: [{ ...base, agent: "explore", outcome: "completed", response: "found it", error: null }],
    })
    expect(text).toBe("## explore - completed (6 turns, 41s, $0.0040)\n\nfound it")
  })

  test("header names the resolved model alias", () => {
    const text = formatReceipt(
      {
        batch_id: "b",
        runs: [{ ...base, model: "google/flash", agent: "reviewer", outcome: "completed", response: "ok", error: null }],
      },
      parseAgentList(listing),
    )
    expect(text.startsWith("## reviewer@flash - completed")).toBe(true)
  })

  test("failed run shows error and stderr", () => {
    const text = formatReceipt({
      batch_id: "b",
      runs: [{ ...base, agent: "x", outcome: "timeout", response: "", error: "deadline", stderr_excerpt: "boom" }],
    })
    expect(text).toContain("error: deadline")
    expect(text).toContain("stderr:\nboom")
  })
})
