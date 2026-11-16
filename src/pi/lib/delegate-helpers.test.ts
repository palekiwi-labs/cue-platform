import { describe, expect, test } from "bun:test"
import {
  BACKGROUND_GUARDRAIL,
  backgroundCommand,
  backgroundJobId,
  batchLabel,
  buildBatchSpec,
  buildDescription,
  formatReceipt,
  parseAgentList,
  placeholderPrompt,
  resolvePrompts,
  selectableAliases,
} from "./delegate-helpers"

describe("backgroundCommand", () => {
  test("runs cue-agent under direnv exec in cwd with receipt and stderr in dir", () => {
    expect(backgroundCommand("cue-agent", "/tmp/j/spec.json", "/tmp/j", "/home/pl/code/x")).toBe(
      "direnv exec '/home/pl/code/x' cue-agent run --spec '/tmp/j/spec.json' --json" +
        " > '/tmp/j/receipt.json' 2> '/tmp/j/stderr.log'",
    )
  })
})

describe("backgroundJobId", () => {
  test("is a lowercase path-safe segment", () => {
    const id = backgroundJobId(new Date("2026-11-01T11:46:25Z"), "a1b2c3")
    expect(id).toBe("delegate-20261101114625-a1b2c3")
    expect(backgroundJobId()).toMatch(/^delegate-\d{14}-[0-9a-f]+$/)
  })
})

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
    expect(r.agents[0]).toMatchObject({ name: "reviewer", description: "reviews", models: ["opus", "flash"], harness: "pi" })
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

describe("BACKGROUND_GUARDRAIL", () => {
  test("reserves background for an explicit operator request", () => {
    expect(BACKGROUND_GUARDRAIL).toContain("only when the operator explicitly asks")
    expect(BACKGROUND_GUARDRAIL).toContain("Foreground is the default")
  })

  test("says foreground tasks still run concurrently", () => {
    expect(BACKGROUND_GUARDRAIL).toContain("still run concurrently while it waits")
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

  test("succeeded supervisor run shows response verbatim", () => {
    const text = formatReceipt({
      batch_id: "b",
      runs: [{ ...base, agent: "explore", outcome: "succeeded", response: "found it", error: null }],
    })
    expect(text).toBe("## explore - succeeded (6 turns, 41s, $0.0040)\n\nfound it")
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

describe("batchLabel", () => {
  test("names the agent and the start of the first prompt", () => {
    expect(batchLabel([{ agent: "explore", prompt: "Find where the session\nbrowser reads descriptions and report" }]))
      .toBe("explore: Find where the session browser reads…")
  })

  test("joins distinct agents in order", () => {
    expect(batchLabel([
      { agent: "reviewer", prompt: "Review" },
      { agent: "reviewer", prompt: "Review" },
      { agent: "readability", prompt: "Check" },
    ])).toBe("reviewer+readability: Review")
  })

  test("falls back to the agents for a blank prompt", () => {
    expect(batchLabel([{ agent: "builder", prompt: "   " }])).toBe("builder")
  })
})

describe("resolvePrompts", () => {
  test("tasks without a prompt inherit the batch prompt", () => {
    expect(resolvePrompts("brief", [null, null])).toEqual({
      defaults: "brief",
      prompts: ["brief", "brief"],
    })
  })

  test("a task prompt replaces the batch prompt", () => {
    expect(resolvePrompts("brief", ["other brief", null])).toEqual({
      defaults: "brief",
      prompts: ["other brief", "brief"],
    })
  })

  test("rejects a task left without any prompt", () => {
    expect(() => resolvePrompts(null, ["a self-contained brief", null])).toThrow(
      /task 2 has no prompt/,
    )
  })

  test("rejects a batch prompt every task overrides", () => {
    expect(() => resolvePrompts("brief", ["own", "own"])).toThrow(/unused/)
  })

  test("accepts per-task prompts with no batch prompt", () => {
    expect(resolvePrompts(null, ["a", "b"]).prompts).toEqual(["a", "b"])
  })
})

describe("placeholderPrompt", () => {
  const real =
    "Review the discount architecture in app/models/package_price.rb and " +
    "recommend whether the gross-up stays. Reply with a short recommendation."

  test("flags the observed degenerate tokens", () => {
    expect(placeholderPrompt("PROMPT_PLACEHOLDER")).toBe("PROMPT_PLACEHOLDER")
    expect(placeholderPrompt("PROMPT_BODY")).toBe("PROMPT_BODY")
  })

  test("flags template shapes and references", () => {
    for (const p of ["<prompt>", "{{prompt}}", "[PROMPT]", "$PROMPT", "TODO", "TBD", "..."]) {
      expect(placeholderPrompt(p)).toBe(p)
    }
    expect(placeholderPrompt("Same as above")).toBe("Same as above")
    expect(placeholderPrompt("same prompt as task 1")).toMatch(/same prompt/)
  })

  test("flags prompts too short to be self-contained", () => {
    expect(placeholderPrompt("review the pricing code")).toBe(
      "review the pricing code",
    )
    expect(placeholderPrompt(real)).toBeNull()
  })

  test("empty prompt is a placeholder", () => {
    expect(placeholderPrompt("  ")).toBe("")
  })
})

describe("buildBatchSpec", () => {
  const long =
    "Investigate the discount rule in app/models and recommend an approach. Reply with a short recommendation."

  test("shared prompt rides the defaults layer", () => {
    const spec = buildBatchSpec(
      {
        prompt: long,
        tasks: [
          { agent: "consultant", model: "opus", prompt: null },
          { agent: "consultant", model: "flash", prompt: null },
        ],
      },
      "/work",
    )
    expect(spec.defaults).toEqual({ prompt: long })
    expect(spec.tasks).toEqual([
      { agent: "consultant", model: "opus", cwd: "/work", env: { CUE_AGENT_NAME: "consultant" } },
      { agent: "consultant", model: "flash", cwd: "/work", env: { CUE_AGENT_NAME: "consultant" } },
    ])
  })

  test("every task names its agent in CUE_AGENT_NAME", () => {
    const spec = buildBatchSpec(
      { prompt: long, tasks: [{ agent: "consultant" }, { agent: "explore", worktree: true }] },
      "/work",
    )
    expect(spec.tasks.map((t) => t.env)).toEqual([{ CUE_AGENT_NAME: "consultant" }, { CUE_AGENT_NAME: "explore" }])
  })

  test("per-task prompt replaces the default", () => {
    const other = "Focus only on the calendar code paths and name risks. Reply with a list."
    const spec = buildBatchSpec(
      {
        prompt: long,
        tasks: [
          { agent: "consultant", prompt: other },
          { agent: "explore", prompt: null },
        ],
      },
      "/work",
    )
    expect(spec.tasks[0]?.prompt).toBe(other)
    expect(spec.tasks[1]?.prompt).toBeUndefined()
  })

  test("per-task prompts without a batch prompt stay per-task", () => {
    const spec = buildBatchSpec(
      { tasks: [{ agent: "consultant", prompt: long }] },
      "/work",
    )
    expect(spec.defaults).toBeUndefined()
    expect(spec.tasks[0]?.prompt).toBe(long)
  })

  test("placeholder prompts are rejected before spawning", () => {
    expect(() =>
      buildBatchSpec(
        { prompt: "PROMPT_PLACEHOLDER", tasks: [{ agent: "consultant", prompt: null }] },
        "/work",
      ),
    ).toThrow(/placeholder/)
    expect(() =>
      buildBatchSpec({ tasks: [{ agent: "consultant", prompt: "PROMPT_BODY" }] }, "/work"),
    ).toThrow(/placeholder/)
  })
})
