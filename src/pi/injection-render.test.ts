import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { collapsedLines, skillBlockTokens, summarizeInjection } from "./injection-render"

const t = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme

const INJECTION = [
  "Active cue context for this session: demo",
  "",
  "PWD: /w",
  "",
  '<cue-context-explore address="o/r/demo" detail="working">',
  "<identity>",
  "address: o/r/demo",
  "kind: work",
  "mode: design",
  "</identity>",
  "",
  "Read an artifact at /s/<address>.",
  "",
  '<log latest="2" total="5">',
  "## one",
  "## two",
  "</log>",
  "",
  "<tasks outstanding>",
  "open  normal  o/r/demo/task/a.md",
  "open  high  o/r/demo/task/b.md",
  "</tasks>",
  "</cue-context-explore>",
  "",
  '<handoff address="o/r/demo/trace/h.md" selected="true">',
  "carry on",
  "</handoff>",
  "",
  "remember the note",
].join("\n")

describe("summarizeInjection", () => {
  test("splits sections and reads address, kind and mode", () => {
    const s = summarizeInjection(INJECTION)
    expect(s.address).toBe("o/r/demo")
    expect(s.kind).toBe("work")
    expect(s.mode).toBe("design")
    expect(s.sections.map((x) => x.label)).toEqual([
      "session", "identity", "misc", "log (2 of 5)", "tasks (2)", "hand-off", "note",
    ])
    expect(s.sections.every((x) => x.tokens > 0)).toBe(true)
    expect(s.total).toBeGreaterThan(0)
  })

  test("plain text without blocks is one session section", () => {
    const s = summarizeInjection("just text")
    expect(s.address).toBeUndefined()
    expect(s.sections.map((x) => x.label)).toEqual(["session"])
  })
})

describe("collapsedLines", () => {
  test("header, totals with skill line, one row per section", () => {
    const s = summarizeInjection(INJECTION)
    const lines = collapsedLines(t, s, 9600)
    expect(lines[0]).toBe("cue context  o/r/demo  work · design")
    expect(lines[1]).toContain("cue skill in system prompt ~9.6k every turn")
    expect(lines).toHaveLength(2 + s.sections.length)
    expect(lines[2]).toMatch(/^ {2}session +\d+ {2}█/)
  })

  test("omits the skill note when its size is unknown", () => {
    const lines = collapsedLines(t, summarizeInjection("x"), undefined)
    expect(lines[1]).not.toContain("cue skill")
  })
})

describe("skillBlockTokens", () => {
  test("counts the skill file and undefined when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-"))
    const path = join(dir, "SKILL.md")
    writeFileSync(path, "---\nname: cue\n---\nhello protocol\n")
    expect(skillBlockTokens(path)).toBeGreaterThan(10)
    expect(skillBlockTokens(join(dir, "missing.md"))).toBeUndefined()
  })
})
