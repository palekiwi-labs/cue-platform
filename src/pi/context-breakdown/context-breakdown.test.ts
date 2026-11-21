import { describe, expect, test } from "bun:test"
import { analyseBreakdown, estimateTokens } from "./breakdown"
import { analyseCache, CACHE_TTL_MS } from "./cache"
import { branchPath, contextEntries, type Entry, parseSessionJsonl, type Usage } from "./entries"
import { buildReport, formatReport, missesByCause } from "./report"
import { buildSnapshot, diffSnapshots, SNAPSHOT_TYPE, splitSystemPrompt } from "./snapshot"

const T0 = Date.parse("2026-01-01T00:00:00Z")

class Session {
  entries: Entry[] = []
  private n = 0
  private parent: string | null = null

  add(e: Omit<Entry, "id" | "parentId" | "timestamp"> & { at?: number }): Entry {
    const { at, ...rest } = e
    const entry: Entry = {
      id: `e${++this.n}`,
      parentId: this.parent,
      timestamp: new Date(at ?? T0 + this.n * 1000).toISOString(),
      ...rest,
    }
    this.entries.push(entry)
    this.parent = entry.id
    return entry
  }

  system(prompt: string, tools: { name: string; description: string }[] = []) {
    return this.add({ type: "message", message: { role: "system", content: "", sections: { preamble: prompt }, toolsAdded: tools } })
  }

  user(text: string) {
    return this.add({ type: "message", message: { role: "user", content: text } })
  }

  assistant(usage: Partial<Usage>, opts: { at?: number; model?: string; text?: string } = {}) {
    const at = opts.at ?? T0 + (this.n + 1) * 1000
    return this.add({
      type: "message",
      at,
      message: {
        role: "assistant",
        content: [{ type: "text", text: opts.text ?? "ok" }],
        provider: "anthropic",
        model: opts.model ?? "claude",
        timestamp: at,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
      },
    })
  }

  toolResult(name: string, text: string) {
    return this.add({ type: "message", message: { role: "toolResult", toolName: name, content: [{ type: "text", text }] } })
  }
}

describe("entries", () => {
  test("parseSessionJsonl separates header and entries and skips junk", () => {
    const text = [
      JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/x" }),
      "not json",
      JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } }),
      "",
    ].join("\n")
    const p = parseSessionJsonl(text)
    expect(p.header?.cwd).toBe("/x")
    expect(p.entries.map((e) => e.id)).toEqual(["a"])
  })

  test("branchPath follows the leaf back to the root, skipping abandoned branches", () => {
    const entries: Entry[] = [
      { type: "message", id: "a", parentId: null, timestamp: "" },
      { type: "message", id: "b", parentId: "a", timestamp: "" },
      { type: "message", id: "c", parentId: "a", timestamp: "" },
    ]
    expect(branchPath(entries).map((e) => e.id)).toEqual(["a", "c"])
  })

  test("contextEntries keeps the compaction, kept entries and what follows", () => {
    const s = new Session()
    s.system("p")
    s.user("old")
    const kept = s.user("kept")
    s.add({ type: "compaction", summary: "sum", firstKeptEntryId: kept.id })
    s.user("new")
    const ids = contextEntries(branchPath(s.entries)).map((e) => e.id)
    expect(ids).toEqual(["e4", "e3", "e5"])
  })
})

describe("snapshot", () => {
  const prompt = [
    "You are pi.",
    "<project_context>",
    '<project_instructions path="/a/AGENTS.md">',
    "alpha",
    "</project_instructions>",
    '<project_instructions path="/b/AGENTS.md">',
    "beta beta",
    "</project_instructions>",
    "</project_context>",
    "<skills>",
    "<skill>",
    "<name>one</name>",
    "</skill>",
    "</skills>",
    "<cwd>/x</cwd>",
  ].join("\n")

  test("splitSystemPrompt finds sections, context files and skills", () => {
    const parts = splitSystemPrompt(prompt)
    expect(parts.map((p) => p.name)).toEqual(["preamble", "project_context", "skills", "untagged"])
    expect(parts[1].items?.map((i) => i.name)).toEqual(["/a/AGENTS.md", "/b/AGENTS.md"])
    expect(parts[2].items?.map((i) => i.name)).toEqual(["one"])
  })

  test("diffSnapshots names changed sections, items and tools", () => {
    const a = buildSnapshot({ systemPrompt: prompt, tools: [{ name: "read" }, { name: "bash" }], model: "m" })
    const b = buildSnapshot({
      systemPrompt: prompt.replace("beta beta", "beta gamma"),
      tools: [{ name: "read", description: "changed" }, { name: "edit" }],
      model: "m",
    })
    const d = diffSnapshots(a, b)
    expect(d.same).toBe(false)
    expect(d.sections).toHaveLength(1)
    expect(d.sections[0].name).toBe("project_context")
    expect(d.sections[0].items?.map((i) => [i.name, i.change])).toEqual([["/b/AGENTS.md", "changed"]])
    expect(d.tools.map((t) => [t.name, t.change])).toEqual([
      ["read", "changed"],
      ["bash", "removed"],
      ["edit", "added"],
    ])
    expect(d.activeAdded).toEqual(["edit"])
    expect(d.activeRemoved).toEqual(["bash"])
    expect(diffSnapshots(a, a).same).toBe(true)
  })

  test("identical input gives an identical hash", () => {
    const a = buildSnapshot({ systemPrompt: prompt, tools: [{ name: "read" }], model: "m" })
    const b = buildSnapshot({ systemPrompt: prompt, tools: [{ name: "read" }], model: "m" })
    expect(a.hash).toBe(b.hash)
  })
})

describe("breakdown", () => {
  test("estimateTokens is chars/4 rounded up", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(5)).toBe(2)
  })

  test("sources come from the transcript prefix and messages, scaled to the exact total", () => {
    const s = new Session()
    s.system("x".repeat(400), [{ name: "read", description: "d".repeat(100) }])
    s.user("u".repeat(400))
    s.add({ type: "custom_message", customType: "cue-context", content: "c".repeat(800) })
    s.assistant({ input: 10, cacheWrite: 990, output: 5 })
    s.toolResult("bash", "r".repeat(1600))
    s.assistant({ input: 100, cacheRead: 1900, output: 5 })
    s.user("trailing")

    const b = analyseBreakdown(s.entries)
    expect(b.prefix).toBe("transcript")
    expect(b.exact).toBe(2000)
    const by = Object.fromEntries(b.sources.map((x) => [x.key, x]))
    expect(by.user.tokens).toBe(100)
    expect(by["custom:cue-context"].tokens).toBe(200)
    expect(by.toolResult.items[0]).toMatchObject({ name: "bash", tokens: 400 })
    expect(by.tools.items[0].name).toBe("read")
    expect(by["system:preamble"].tokens).toBe(100)
    expect(b.scale).toBeCloseTo(2000 / b.estimate)
    const scaledSum = b.sources.reduce((n, x) => n + x.scaled, 0)
    expect(Math.abs(scaledSum - 2000)).toBeLessThan(b.sources.length)
    expect(b.trailing).toBe(3)
  })

  test("a snapshot entry overrides the transcript prefix", () => {
    const s = new Session()
    const snap = buildSnapshot({ systemPrompt: "<cue-skill>\nbody\n</cue-skill>", tools: [], model: null })
    s.add({ type: "custom", customType: SNAPSHOT_TYPE, data: snap })
    s.user("hello")
    s.assistant({ input: 100 })
    const b = analyseBreakdown(s.entries)
    expect(b.prefix).toBe("snapshot")
    expect(b.sources.some((x) => x.key === "system:cue-skill")).toBe(true)
  })

  test("without snapshot or system message the prefix is unknown", () => {
    const s = new Session()
    s.user("hello")
    s.assistant({ input: 100 })
    const b = analyseBreakdown(s.entries)
    expect(b.prefix).toBe("unknown")
    expect(b.sources.map((x) => x.group)).toEqual(["messages"])
  })

  test("context edits and compaction summaries are applied", () => {
    const s = new Session()
    s.system("p")
    const r = s.toolResult("read", "z".repeat(4000))
    s.add({ type: "context_edit", targetId: r.id, replacement: { content: "short" } })
    s.assistant({ input: 50 })
    let b = analyseBreakdown(s.entries)
    expect(b.sources.find((x) => x.key === "toolResult")?.chars).toBe(5)

    const t = new Session()
    t.system("p")
    t.user("old")
    const kept = t.user("kept")
    t.add({ type: "compaction", summary: "s".repeat(40), firstKeptEntryId: kept.id })
    t.assistant({ input: 50 })
    b = analyseBreakdown(t.entries)
    expect(b.sources.find((x) => x.key === "compaction")?.tokens).toBe(10)
    expect(b.sources.find((x) => x.key === "user")?.chars).toBe(4)
  })
})

describe("cache", () => {
  test("turn usage, hit ratio and an unexplained miss", () => {
    const s = new Session()
    s.assistant({ input: 10, cacheWrite: 5000, output: 1 })
    s.assistant({ input: 10, cacheRead: 5000, cacheWrite: 100, output: 1 })
    s.assistant({ input: 5000, cacheRead: 200, output: 1 })
    const c = analyseCache(s.entries)
    expect(c.turns.map((t) => t.prompt)).toEqual([5010, 5110, 5200])
    expect(c.turns[1].hitRatio).toBeCloseTo(5000 / 5110)
    expect(c.misses).toBe(1)
    expect(c.turns[2].miss?.missedTokens).toBe(5110 - 200)
    expect(c.turns[2].miss?.causes).toEqual(["unknown"])
  })

  test("idle beyond TTL and model change are causes", () => {
    const s = new Session()
    s.assistant({ input: 10, cacheWrite: 5000 }, { at: T0 })
    s.assistant({ input: 5000, cacheRead: 10 }, { at: T0 + CACHE_TTL_MS + 1000 })
    s.assistant({ input: 5000, cacheRead: 10 }, { at: T0 + CACHE_TTL_MS + 2000, model: "other" })
    const c = analyseCache(s.entries)
    expect(c.turns[1].miss?.causes).toEqual(["idle"])
    expect(c.turns[2].miss?.causes).toEqual(["model"])
    expect(missesByCause(c).map((m) => m.cause).sort()).toEqual(["idle", "model"])
  })

  test("misses at or below the noise floor and on cacheless providers are ignored", () => {
    const s = new Session()
    s.assistant({ input: 10, cacheWrite: 5000 })
    s.assistant({ input: 1000, cacheRead: 4010 })
    expect(analyseCache(s.entries).misses).toBe(0)

    const t = new Session()
    t.assistant({ input: 5000 })
    t.assistant({ input: 6000 })
    const c = analyseCache(t.entries)
    expect(c.misses).toBe(0)
    expect(c.reportsCache).toBe(false)
  })

  test("compaction resets the baseline and is reported as a rebuild", () => {
    const s = new Session()
    s.assistant({ input: 10, cacheWrite: 50000 })
    s.add({ type: "compaction", summary: "s", firstKeptEntryId: "e1" })
    s.assistant({ input: 10, cacheWrite: 8000 })
    const c = analyseCache(s.entries)
    expect(c.compactions).toBe(1)
    expect(c.misses).toBe(0)
    expect(c.compactionRebuilds).toBe(1)
    expect(c.turns[1].afterCompaction).toBe(true)
    expect(c.turns[1].miss?.causes).toEqual(["compaction"])
  })

  test("a prefix change between snapshots is named as the cause", () => {
    const s = new Session()
    const a = buildSnapshot({ systemPrompt: "<cwd>/a</cwd>", tools: [], model: null })
    const b = buildSnapshot({ systemPrompt: "<cwd>/b</cwd>", tools: [], model: null })
    s.add({ type: "custom", customType: SNAPSHOT_TYPE, data: a })
    s.assistant({ input: 10, cacheWrite: 5000 })
    s.add({ type: "custom", customType: SNAPSHOT_TYPE, data: b })
    s.assistant({ input: 5000, cacheRead: 10 })
    const c = analyseCache(s.entries)
    expect(c.turns[1].miss?.causes).toEqual(["prefix"])
    expect(c.turns[1].miss?.prefixChanges[0]).toContain("section preamble changed")
  })

  test("cache_warm usage entries refresh the baseline", () => {
    const s = new Session()
    s.assistant({ input: 10, cacheWrite: 5000 }, { at: T0 })
    s.add({
      type: "usage",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude",
      usage: { input: 0, output: 0, cacheRead: 5010, cacheWrite: 0 },
      at: T0 + CACHE_TTL_MS - 1000,
    })
    s.assistant({ input: 10, cacheRead: 5010 }, { at: T0 + 2 * CACHE_TTL_MS - 2000 })
    expect(analyseCache(s.entries).misses).toBe(0)
  })
})

describe("report", () => {
  test("lists prefix changes between snapshots and renders text", () => {
    const s = new Session()
    const a = buildSnapshot({ systemPrompt: "one", tools: [{ name: "read" }], model: "m" })
    const b = buildSnapshot({ systemPrompt: "one", tools: [{ name: "read" }, { name: "bash" }], model: "m" })
    s.add({ type: "custom", customType: SNAPSHOT_TYPE, data: a })
    s.user("hi")
    s.assistant({ input: 10, cacheWrite: 3000 })
    s.add({ type: "custom", customType: SNAPSHOT_TYPE, data: b })
    s.assistant({ input: 10, cacheRead: 3000 })
    const r = buildReport({ entries: s.entries, contextWindow: 200000 })
    expect(r.snapshots).toBe(2)
    expect(r.prefixChanges).toHaveLength(1)
    expect(r.prefixChanges[0].diff.tools[0]).toMatchObject({ name: "bash", change: "added" })
    const text = formatReport(r)
    expect(text).toContain("== breakdown ==")
    expect(text).toContain("tool bash added")
    expect(formatReport(r, { turns: 0 })).not.toContain("cWrite")
  })
})
