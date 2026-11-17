import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, type TUI } from "@earendil-works/pi-tui"
import { ALL_TIME_DAYS, RECENCY_STEPS, type ContextRow } from "../browser/model"
import type { Pr } from "./model"
import { type PickerResult, ContextPicker } from "./context-picker"

const row = (slug: string, depth = 0): ContextRow => ({
  address: `o/r/${slug}`, scope: "o/r", slug, title: slug, mode: null, kind: "work", pinned: false,
  lastLoggedAt: Math.floor(Date.now() / 1000), createdAt: null, archivedAt: null, path: "", depth, connectors: [], isLast: true,
})

function setup(extra: {
  purpose?: "review" | "parent" | "conversation"; scope?: string; branch?: string; linked?: string; here?: string; context?: string; rows?: ContextRow[]; recencyDays?: number
} = {}) {
  const results: PickerResult[] = []
  const saved: number[] = []
  let cancelled = false
  const tui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
  const keys: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down" }
  const kb = { matches: (d: string, id: string) => (keys[id] ? matchesKey(d, keys[id] as Parameters<typeof matchesKey>[1]) : false) } as unknown as KeybindingsManager
  const p = new ContextPicker(tui, theme, kb, {
    pr: { number: 7, title: "T" } as Pr,
    context: "review-t",
    manifests: ["default", "quick"],
    manifest: 0,
    rows: [row("alpha"), row("beta")],
    recencyDays: undefined,
    ...extra,
  }, {
    submit: (r) => results.push(r),
    cancel: () => (cancelled = true),
    saveRecencyDays: (days) => saved.push(days),
  })
  const type = (s: string) => [...s].forEach((c) => p.handleInput(c))
  return { p, results, saved, type, cancelled: () => cancelled }
}

describe("ContextPicker", () => {
  test("without the review context, enter creates it under the highlighted context", () => {
    const s = setup()
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default", parent: "o/r/alpha" }])
  })

  test("search moves the parent; tab cycles the manifest", () => {
    const s = setup()
    s.type("bet")
    s.p.handleInput("\t")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "quick", parent: "o/r/beta" }])
  })

  test("an existing review context is reused without a parent", () => {
    const s = setup({ rows: [row("alpha"), row("t"), row("review-t")], scope: "o/r", branch: "t" })
    s.type("alp")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("the linked context comes before <branch> as the starting parent", () => {
    const rows = [row("alpha"), row("beta"), row("work")]
    const a = setup({ rows, scope: "o/r", branch: "beta", linked: "o/r/work" })
    a.p.handleInput("\r")
    expect(a.results[0]!.parent).toBe("o/r/work")
    const b = setup({ rows, scope: "o/r", branch: "beta" })
    b.p.handleInput("\r")
    expect(b.results[0]!.parent).toBe("o/r/beta")
  })

  test("with no contexts enter creates at the top level", () => {
    const s = setup({ rows: [] })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("parent: (no parent) is the default without a session context", () => {
    const s = setup({ purpose: "parent", context: "feat-x", scope: "o/r" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "feat-x" }])
  })

  test("parent: the session context is highlighted; enter creates under it", () => {
    const s = setup({ purpose: "parent", context: "feat-x", scope: "o/r", here: "o/r/beta" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "feat-x", parent: "o/r/beta" }])
  })

  test("parent: moving down from (no parent) picks a context; search drops the row", () => {
    const a = setup({ purpose: "parent", context: "feat-x", scope: "o/r" })
    a.p.handleInput("\x1b[B")
    a.p.handleInput("\r")
    expect(a.results).toEqual([{ context: "feat-x", parent: "o/r/alpha" }])
    const b = setup({ purpose: "parent", context: "feat-x", scope: "o/r" })
    b.type("bet")
    b.p.handleInput("\r")
    expect(b.results).toEqual([{ context: "feat-x", parent: "o/r/beta" }])
  })

  test("parent: ctrl+e renames (enter keeps, esc undoes, existing refused)", () => {
    const s = setup({ purpose: "parent", context: "feat-x", scope: "o/r" })
    s.p.handleInput("\x05")
    s.type("-2")
    s.p.handleInput("\x1b")
    s.p.handleInput("\x05")
    s.p.handleInput("\x15")
    s.type("alpha")
    s.p.handleInput("\r")
    expect(s.p.render(100).at(-1)).toContain("exists")
    s.type("-2")
    s.p.handleInput("\r")
    expect(s.results).toEqual([])
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "alpha-2" }])
  })

  for (const purpose of ["review", "parent", "conversation"] as const) {
    test(`${purpose}: recency cycles through all-time and wraps in both directions`, () => {
      const old = { ...row("old"), lastLoggedAt: null }
      const s = setup({ purpose, rows: [row("fresh"), old], recencyDays: 30 })
      expect(s.p.render(160).join("\n")).not.toContain("old")
      s.p.handleInput("\x1b[1;5A")
      expect(s.p.render(160)[0]).toContain("all-time")
      expect(s.p.render(160).join("\n")).toContain("old")
      expect(s.p.render(160).join("\n")).not.toContain("alt+a")
      s.p.handleInput("\x1ba")
      expect(s.p.render(160)[0]).toContain("all-time")
      s.p.handleInput("\x1b[1;5A")
      expect(s.p.render(160)[0]).toContain("recent 1d")
      s.p.handleInput("\x1b[1;5B")
      expect(s.p.render(160)[0]).toContain("all-time")
      s.p.handleInput("\x1b[1;5B")
      expect(s.p.render(160)[0]).toContain("recent 30d")
      expect(s.saved).toEqual([ALL_TIME_DAYS, 1, ALL_TIME_DAYS, 30])
      for (let i = 0; i < RECENCY_STEPS.length; i++) s.p.handleInput("\x1b[1;5A")
      expect(s.saved.slice(4)).toEqual([ALL_TIME_DAYS, 1, 2, 3, 7, 14, 30])
    })

    test(`${purpose}: stored all-time includes old query matches`, () => {
      const s = setup({ purpose, rows: [{ ...row("old"), lastLoggedAt: null }], recencyDays: ALL_TIME_DAYS })
      s.type("old")
      expect(s.p.render(160)[0]).toContain("all-time")
      s.p.handleInput("\r")
      expect(s.results).toEqual(purpose === "review"
        ? [{ context: "review-t", manifest: "default", parent: "o/r/old" }]
        : purpose === "conversation"
          ? [{ context: "o/r/old" }]
          : [{ context: "review-t", parent: "o/r/old" }])
    })

    test(`${purpose}: preselection widens locally and the next step wraps to 1d`, () => {
      const s = setup({ purpose, rows: [{ ...row("old"), lastLoggedAt: null }], linked: "o/r/old", here: "o/r/old" })
      expect(s.p.render(160)[0]).toContain("all-time")
      expect(s.saved).toEqual([])
      s.p.handleInput("\x1b[1;5A")
      expect(s.p.render(160)[0]).toContain("recent 1d")
      expect(s.saved).toEqual([1])
    })
  }

  test("conversation selects an address without manifest controls", () => {
    const s = setup({ purpose: "conversation", context: "beta", branch: "beta", scope: "o/r" })
    const text = s.p.render(160).join("\n")
    expect(text).toContain("enter select and link")
    expect(text).not.toContain("manifest")
    s.p.handleInput("\t")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "o/r/beta" }])
  })

  test("conversation suggests review-branch but allows another selection", () => {
    const s = setup({ purpose: "conversation", context: "t", branch: "t", scope: "o/r",
      rows: [row("alpha"), row("t"), row("review-t")] })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "o/r/review-t" }])
    s.type("alp")
    s.p.handleInput("\r")
    expect(s.results.at(-1)).toEqual({ context: "o/r/alpha" })
  })

  test("conversation creation requests a separate parent choice, including an empty tree", () => {
    for (const rows of [[], [row("alpha")]]) {
      const s = setup({ purpose: "conversation", context: "t", branch: "t", rows })
      s.p.handleInput("\x0e")
      expect(s.results).toEqual([{ context: "t", create: true }])
    }
  })

  test("parent refuses creation over an existing context until renamed", () => {
    const s = setup({ purpose: "parent", context: "alpha", scope: "o/r" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([])
    expect(s.p.render(100).at(-1)).toContain("exists")
    s.p.handleInput("\x05")
    s.type("-new")
    s.p.handleInput("\r")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "alpha-new" }])
  })

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })
})
