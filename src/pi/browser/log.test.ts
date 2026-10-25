import { describe, expect, test } from "bun:test"
import { entryAddress, entryLink, fmtStamp, logPreview, parseLog, sortLog, tracePath } from "./log"

const raw = (over: Record<string, unknown> = {}) => ({
  timestamp: 1792854954237737617,
  title: "Log view  design\nagreed",
  trace: null,
  found: [],
  decided: ["ctrl+g opens it"],
  open: [],
  ...over,
})

describe("parseLog", () => {
  test("converts nanoseconds to milliseconds and normalises the title", () => {
    const [e] = parseLog(JSON.stringify([raw()]))
    expect(e!.timestamp).toBe(1792854954237)
    expect(e!.title).toBe("Log view design agreed")
    expect(e!.decided).toEqual(["ctrl+g opens it"])
    expect(e!.trace).toBeNull()
  })

  test("drops malformed entries and survives bad input", () => {
    expect(parseLog(JSON.stringify([{ title: "x" }, raw()]))).toHaveLength(1)
    expect(parseLog("not json")).toEqual([])
    expect(parseLog("{}")).toEqual([])
    expect(parseLog("")).toEqual([])
  })

  test("ids stay unique for equal timestamps", () => {
    const es = parseLog(JSON.stringify([raw(), raw()]))
    expect(es[0]!.id).not.toBe(es[1]!.id)
  })
})

test("sortLog lists newest first", () => {
  const es = parseLog(JSON.stringify([raw({ timestamp: 1e18 }), raw({ timestamp: 2e18 })]))
  expect(sortLog(es).map((e) => e.timestamp)).toEqual([2e12, 1e12])
})

describe("logPreview", () => {
  test("renders title and non-empty sections only", () => {
    const [e] = parseLog(JSON.stringify([raw()]))
    const md = logPreview(e!)
    expect(md).toContain("# Log view design agreed")
    expect(md).toContain("**Decided**\n\n- ctrl+g opens it")
    expect(md).not.toContain("Found")
    expect(md).not.toContain("trace")
  })

  test("appends the trace with frontmatter fenced", () => {
    const [e] = parseLog(JSON.stringify([raw({ trace: "a/b/c/trace/h.md" })]))
    const md = logPreview(e!, "---\nrepo_id: x\n---\n# Hand-off\n")
    expect(md).toContain("_trace a/b/c/trace/h.md_")
    expect(md).toContain("```yaml\nrepo_id: x\n```\n# Hand-off")
  })

  test("notes a missing trace", () => {
    const [e] = parseLog(JSON.stringify([raw({ trace: "a/b/c/trace/h.md" })]))
    expect(logPreview(e!, null)).toContain("_trace not found in this store_")
  })
})

test("tracePath joins the store root", () => {
  const [e] = parseLog(JSON.stringify([raw({ trace: "a/b/c/trace/h.md" })]))
  expect(tracePath(e!, "/s")).toBe("/s/a/b/c/trace/h.md")
  const [n] = parseLog(JSON.stringify([raw()]))
  expect(tracePath(n!, "/s")).toBeNull()
})

test("fmtStamp is fixed width with time this year and year before it", () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime()
  expect(fmtStamp(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe("Oct  3 09:05")
  expect(fmtStamp(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe("Dec 31  2025")
})

test("entryAddress keeps the exact nanosecond stamp, zero-padded", () => {
  const [e] = parseLog('[{"timestamp": 1792916036337401119, "title": "t"}]')
  expect(e!.stamp).toBe("1792916036337401119")
  expect(entryAddress(e!, "o/r/ctx")).toBe("o/r/ctx/log/01792916036337401119.json")
})

test("entryLink titles the address and escapes brackets", () => {
  const [e] = parseLog('[{"timestamp": 1792916036337401119, "title": "a [b] \\"timestamp\\": 1"}]')
  expect(entryLink(e!, "o/r/c")).toBe('[a \\[b\\] "timestamp": 1](o/r/c/log/01792916036337401119.json)')
})
