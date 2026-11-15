import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ExploreError,
  exploreContext,
  handoffBriefing,
  parseContextAddress,
  parseDetail,
  stripFrontmatter,
  type Exec,
} from "./context-explore"

const A = "o/r/demo"
const NOW = Date.UTC(2026, 0, 1)

interface Fake {
  contexts: Record<string, unknown>[]
  artifacts: Record<string, unknown>[]
  logs: { timestamp: number; trace: string | null }[]
}

function fakeExec(store: string, fake: Fake): Exec {
  const ok = (v: unknown) => ({
    stdout: typeof v === "string" ? v : JSON.stringify(v),
    stderr: "",
    code: 0,
    killed: false,
  })
  return {
    exec: (async (_cmd: string, args: string[]) => {
      const line = args.join(" ")
      if (line === `status --context ${A} --json`) return ok({ store, address: A })
      if (line.startsWith("context list --scope store --archived")) return ok(fake.contexts)
      if (line.startsWith("context list")) return ok("")
      if (line === `list --context ${A} --frontmatter`) return ok(fake.artifacts)
      if (line === `log list --context ${A}`) return ok(fake.logs)
      if (line.startsWith(`log list --context ${A} --format md --limit`)) {
        const n = Number(args[args.length - 1])
        return ok(fake.logs.slice(0, n).map((l) => `## entry ${l.timestamp}`).join("\n\n"))
      }
      if (line.startsWith("activity list")) return ok([])
      return { stdout: "", stderr: "Error: no such context", code: 1, killed: false }
    }) as Exec["exec"],
  }
}

describe("parsing", () => {
  test("detail defaults to brief and rejects unknown names with the valid list", () => {
    expect(parseDetail(undefined)).toBe("brief")
    expect(parseDetail("working")).toBe("working")
    expect(() => parseDetail("full")).toThrow("identity, brief, working")
  })

  test("only context addresses are accepted", () => {
    expect(parseContextAddress("/o/r/demo/")).toBe(A)
    expect(() => parseContextAddress("o/r/demo/task/t.md")).toThrow(ExploreError)
    expect(() => parseContextAddress("demo")).toThrow(ExploreError)
  })

  test.each([
    ["frontmatter", "---\ntitle: x\n---\n\nBody\n", "Body"],
    ["none", "Body\n", "Body"],
    ["BOM and CRLF", "\uFEFF---\r\na: b\r\n---\r\nBody\r\n", "Body"],
    ["metadata only", "---\na: b\n---\n", ""],
  ])("stripFrontmatter: %s", (_n, input, out) => {
    expect(stripFrontmatter(input)).toBe(out)
  })
})

describe("exploreContext", () => {
  let store: string
  let fake: Fake

  const write = async (rel: string, text: string) => {
    await mkdir(join(store, rel, ".."), { recursive: true })
    await writeFile(join(store, rel), text)
  }
  const art = (type: string, name: string, frontmatter: Record<string, unknown> = {}) => ({
    path: join(store, A, type, name),
    name,
    type,
    frontmatter,
  })

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "cue-explore-"))
    fake = {
      contexts: [
        { scope: "o/r", context: "demo", title: "Demo", kind: "work", mode: "build",
          parent: "o/r/root", refs: ["x/y/other", "o/r/root/spec/index.md"] },
        { scope: "o/r", context: "root", title: "Root", kind: "coord" },
        { scope: "x/y", context: "other", title: "Other scope", kind: "reference" },
        { scope: "o/r", context: "kid", title: "Kid", kind: "work", parent: A },
      ],
      artifacts: [],
      logs: [],
    }
    await write(`${A}/context.md`, "---\ntitle: Demo\n---\n\nDo X here.\n")
  })

  afterEach(async () => {
    await rm(store, { recursive: true, force: true })
  })

  test("identity lists links with titles and nothing else", async () => {
    const out = await exploreContext(fakeExec(store, fake), "/w", A, "identity", NOW)
    expect(out).toContain("title: Demo")
    expect(out).toContain("  - o/r/root [coord]  Root")
    expect(out).toContain("  - x/y/other [reference]  Other scope")
    expect(out).toContain("  - o/r/root/spec/index.md")
    expect(out).toContain("children (1):\n  - o/r/kid [work]  Kid")
    expect(out).not.toContain("<context-body")
    expect(out).toContain(`Read an artifact at ${store}/<address>`)
  })

  test("brief attributes the body, lists outstanding tasks and document addresses", async () => {
    fake.artifacts = [
      art("task", "b.md", { status: "open", priority: "low", title: "Low" }),
      art("task", "a.md", { status: "in-progress", priority: "high", title: "High" }),
      art("task", "c.md", { status: "complete" }),
      art("spec", "index.md"),
      art("plan", "index.md"),
      art("plan", "open.md", { status: "open" }),
      art("plan", "done.md", { status: "complete" }),
      art("trace", "handoff-new.md", { created_at: 1767225600 }),
      art("trace", "handoff-old.md", { created_at: 1 }),
      art("trace", "handoff-mid.md", { created_at: 1767139200 }),
      art("trace", "handoff-oldest.md", {}),
      art("trace", "review.md", { created_at: 3 }),
    ]
    fake.logs = [
      { timestamp: 4e9, trace: `${A}/trace/review.md` },
      { timestamp: 3e9, trace: null },
      { timestamp: 2e9, trace: `${A}/trace/handoff-new.md` },
      { timestamp: 0, trace: null },
    ]
    const out = await exploreContext(fakeExec(store, fake), "/w", A, "brief", NOW)
    expect(out).toContain(`<context-body address="${A}">\nDo X here.\n</context-body>`)
    expect(out).toContain(
      `in-progress  high  ${A}/task/a.md  High\nopen  low  ${A}/task/b.md  Low\n</tasks>`,
    )
    expect(out).not.toContain("task/c.md")
    expect(out).toContain('<log latest="3" total="4">')
    expect(out).toContain("1 older entries omitted")
    expect(out).toContain(
      `spec: ${A}/spec/index.md\nmaster plan: ${A}/plan/index.md\n` +
        `open plan: ${A}/plan/open.md\n` +
        "hand-off history (oldest first; none is selected for this session, " +
        "and recency implies neither relevance nor unresolved work):\n" +
        `  - ${A}/trace/handoff-old.md  1970-01-01 00:00 UTC\n` +
        `  - ${A}/trace/handoff-mid.md  2025-12-31 00:00 UTC\n` +
        `  - ${A}/trace/handoff-new.md  2026-01-01 00:00 UTC\n` +
        "  (1 older hand-offs not listed)\n</documents>",
    )
    expect(out).not.toContain("latest hand-off")
    expect(out).not.toContain("trace/review.md")
    expect(out).not.toContain("plan/done.md")
    expect(out).not.toContain("<handoff")
    expect(out.indexOf("<documents>")).toBeLessThan(out.indexOf("<log"))
    expect(out.trimEnd().endsWith("</tasks>\n</cue-context-explore>")).toBe(true)
  })

  test("working lists hand-off addresses but never their content", async () => {
    await write(`${A}/spec/index.md`, "# Spec\n")
    await write(`${A}/trace/handoff-x.md`, "# Hand-off body\n")
    fake.artifacts = [
      art("spec", "index.md"),
      art("trace", "handoff-x.md", { created_at: 1 }),
    ]
    fake.logs = [{ timestamp: 5e9, trace: `${A}/trace/handoff-x.md` }]
    const out = await exploreContext(fakeExec(store, fake), "/w", A, "working", NOW)
    expect(out).toContain(`spec: ${A}/spec/index.md`)
    expect(out).not.toContain("# Spec")
    expect(out).toContain(`  - ${A}/trace/handoff-x.md`)
    expect(out).not.toContain("<handoff")
    expect(out).not.toContain("Hand-off body")
  })

  describe("handoffBriefing", () => {
    const H = `${A}/trace/handoff-x.md`

    test("injects exactly the selected hand-off, not the newest", async () => {
      await write(`${A}/trace/handoff-x.md`, "---\ncreated_at: 1\n---\n# X state\n")
      await write(`${A}/trace/handoff-y.md`, "# Y state\n")
      fake.artifacts = [
        art("trace", "handoff-x.md", { created_at: 1 }),
        art("trace", "handoff-y.md", { created_at: 9 }),
      ]
      fake.logs = [
        { timestamp: 9e9, trace: `${A}/trace/handoff-y.md` },
        { timestamp: 3e9, trace: null },
        { timestamp: 2e9, trace: H },
      ]
      const r = await handoffBriefing(fakeExec(store, fake), "/w", A, `/${H}/`)
      expect(r.address).toBe(H)
      expect(r.briefing).toBe(
        `<handoff address="${H}" selected="true" entries-since="2">\n` +
          "---\ncreated_at: 1\n---\n# X state\n</handoff>",
      )
      expect(r.briefing).not.toContain("Y state")
    })

    test("truncates long hand-offs", async () => {
      await write(`${A}/trace/handoff-x.md`, Array.from({ length: 305 }, (_, i) => `l${i}`).join("\n"))
      fake.artifacts = [art("trace", "handoff-x.md", { created_at: 1 })]
      const r = await handoffBriefing(fakeExec(store, fake), "/w", A, H)
      expect(r.briefing).toContain('truncated="true"')
      expect(r.briefing).toContain(`[truncated: 5 more lines; read ${H}]`)
    })

    test.each([
      ["another context", "o/r/other/trace/handoff-x.md", "does not belong to context o/r/demo"],
      ["a non-hand-off trace", `${A}/trace/review.md`, "is not a hand-off"],
      ["a non-trace artifact", `${A}/note/handoff-x.md`, "is not a hand-off"],
      ["a context address", A, "is not an artifact address"],
      ["an escaping path", `${A}/trace/../handoff-x.md`, "is not an artifact address"],
    ])("rejects %s", async (_n, handoff, message) => {
      fake.artifacts = [art("trace", "handoff-x.md", { created_at: 1 })]
      await expect(
        handoffBriefing(fakeExec(store, fake), "/w", A, handoff),
      ).rejects.toThrow(message)
    })

    test("fails for a hand-off missing from the context", async () => {
      fake.artifacts = [art("trace", "handoff-y.md", { created_at: 9 })]
      await expect(
        handoffBriefing(fakeExec(store, fake), "/w", A, H),
      ).rejects.toThrow(`no hand-off ${H} in context ${A}`)
    })

    test("fails for an unreadable hand-off", async () => {
      fake.artifacts = [art("trace", "handoff-x.md", { created_at: 1 })]
      await expect(
        handoffBriefing(fakeExec(store, fake), "/w", A, H),
      ).rejects.toThrow(`cannot read hand-off ${H}`)
    })
  })

  test("unknown context fails", async () => {
    await expect(
      exploreContext(fakeExec(store, fake), "/w", "o/r/nope", "brief", NOW),
    ).rejects.toThrow("no such context o/r/nope")
  })
})
