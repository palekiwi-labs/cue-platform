import { describe, expect, test } from "bun:test"
import { fakeSource } from "./fake"
import {
  fmtDuration,
  memoryPreview,
  memoryRows,
  type ReflectionRun,
  runDetail,
  runStatus,
  runTone,
  triggerText,
} from "./model"

const run = (over: Partial<ReflectionRun> = {}): ReflectionRun => ({
  id: "r-1",
  sessionId: "s-1",
  trigger: { kind: "manual" },
  state: "done",
  outcome: "committed",
  model: "m",
  started: 0,
  durationSecs: 10,
  log: [],
  ...over,
})

describe("run status", () => {
  test("running wins over outcome", () => {
    const r = run({ state: "running", outcome: undefined })
    expect(runStatus(r)).toBe("running")
    expect(runTone(r)).toBe("live")
  })

  test("outcomes map to words and tones", () => {
    expect(runStatus(run({ outcome: "no_changes" }))).toBe("no changes")
    expect(runTone(run({ outcome: "no_changes" }))).toBe("dim")
    expect(runTone(run({ outcome: "committed" }))).toBe("ok")
    expect(runTone(run({ outcome: "failed" }))).toBe("bad")
  })
})

describe("formatting", () => {
  test("durations", () => {
    expect(fmtDuration(undefined)).toBe("-")
    expect(fmtDuration(42)).toBe("42s")
    expect(fmtDuration(74)).toBe("1m14s")
  })

  test("triggers", () => {
    expect(triggerText({ kind: "manual" })).toBe("manual")
    expect(triggerText({ kind: "cue-log", title: "x" })).toBe("cue-log: x")
  })

  test("run detail carries error and log", () => {
    const text = runDetail(run({ outcome: "failed", error: "boom", log: ["a", "b"] }))
    expect(text).toContain("**error:** boom")
    expect(text).toContain("```\na\nb\n```")
  })
})

describe("memory rows", () => {
  test("level heading precedes its files", async () => {
    const levels = await fakeSource(0).levels("/")
    const rows = memoryRows(levels)
    expect(rows[0]!.id).toBe("level:user")
    expect(rows[1]!.file?.path).toBe("user/MEMORY.md")
    expect(memoryPreview(rows[0]!)).toContain("`user/MEMORY.md`")
    expect(memoryPreview(rows[1]!)).toContain("# User memory")
  })

  test("empty level says so", () => {
    const [row] = memoryRows([{ label: "scope", path: "scopes/a/b", files: [] }])
    expect(memoryPreview(row!)).toBe("_no memory files in scopes/a/b_")
  })
})

describe("fake source", () => {
  test("covers every run outcome and has a diff per commit", async () => {
    const src = fakeSource(0)
    const runs = await src.runs()
    expect(new Set(runs.map(runStatus))).toEqual(new Set(["running", "committed", "no changes", "failed"]))
    for (const c of await src.commits()) expect(await src.show(c.hash)).toBeDefined()
  })
})
