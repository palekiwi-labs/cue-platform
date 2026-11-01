import { describe, expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { syntheticContext, type SessionRow } from "./browser/sessions"
import { headerLines, revisionText } from "./header"

const t = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme

describe("revisionText", () => {
  test("hash, branch and dirty marker", () => {
    expect(revisionText({ hash: "33f281b", branch: "master", dirty: true }))
      .toBe("cue-platform 33f281b (master, +dirty)")
    expect(revisionText({ hash: "abc1234", dirty: false })).toBe("cue-platform abc1234 (detached)")
    expect(revisionText(undefined)).toBe("cue-platform (revision unknown)")
  })
})

describe("headerLines", () => {
  const s = (description: string, modified: number, label?: string): SessionRow => ({
    path: description, cwd: "/w", description, label, tokens: null, modified,
  })
  const rev = { hash: "abc1234", branch: "main", dirty: false }

  test("rows show age, context or dash, description and label", () => {
    const lines = headerLines(t, 80, rev, [
      { session: s("welcome", 1000 - 120, "idea"), context: syntheticContext("o/r/inbox") },
      { session: s("loose", 1000 - 7200), context: syntheticContext("") },
    ], 3, 1000)
    expect(lines.some((l) => l.includes("ctrl+r to resume"))).toBe(true)
    expect(lines).toContain("    2m  inbox | welcome [idea]")
    expect(lines).toContain("    2h  - | loose")
  })

  test("a description equal to the context shows once", () => {
    const lines = headerLines(t, 80, rev, [
      { session: s("inbox", 1000 - 60), context: syntheticContext("o/r/inbox") },
    ], 3, 1000)
    expect(lines).toContain("    1m  inbox")
  })

  test("narrow terminals get the one-line logo", () => {
    expect(headerLines(t, 20, rev, [], 3, 0)).toContain("  cue platform")
  })

  test("loading state before sessions arrive", () => {
    expect(headerLines(t, 80, rev, undefined, 3, 0)).toContain("  loading…")
  })
})
