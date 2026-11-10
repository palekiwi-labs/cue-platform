import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ExploreError,
  exploreContext,
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
    ]
    fake.logs = [
      { timestamp: 3, trace: null },
      { timestamp: 2, trace: `${A}/trace/handoff.md` },
      { timestamp: 1, trace: `${A}/trace/old.md` },
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
        `open plan: ${A}/plan/open.md\nlatest hand-off: ${A}/trace/handoff.md`,
    )
    expect(out).not.toContain("plan/done.md")
    expect(out).not.toContain("<artifact")
  })

  test("working prints documents in full, notes truncation and missing files", async () => {
    await write(`${A}/spec/index.md`, "# Spec\n")
    await write(`${A}/plan/long.md`, Array.from({ length: 305 }, (_, i) => `l${i}`).join("\n"))
    fake.artifacts = [art("spec", "index.md"), art("plan", "long.md", { status: "open" })]
    fake.logs = [{ timestamp: 1, trace: `${A}/trace/gone.md` }]
    const out = await exploreContext(fakeExec(store, fake), "/w", A, "working", NOW)
    expect(out).toContain(`<artifact address="${A}/spec/index.md">\n# Spec\n</artifact>`)
    expect(out).toContain(`<artifact address="${A}/plan/long.md" truncated="true">`)
    expect(out).toContain(`[truncated: 5 more lines; read ${A}/plan/long.md]`)
    expect(out).toContain(`<artifact address="${A}/trace/gone.md" missing="true">`)
    expect(out).not.toContain("<documents>")
  })

  test("unknown context fails", async () => {
    await expect(
      exploreContext(fakeExec(store, fake), "/w", "o/r/nope", "brief", NOW),
    ).rejects.toThrow("no such context o/r/nope")
  })
})
