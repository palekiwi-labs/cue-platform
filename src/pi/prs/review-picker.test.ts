import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, type TUI } from "@earendil-works/pi-tui"
import type { ContextRow } from "../browser/model"
import type { Pr } from "./model"
import { type PickerResult, ReviewPicker } from "./review-picker"

const row = (slug: string, depth = 0): ContextRow => ({
  address: `o/r/${slug}`, scope: "o/r", slug, title: slug, mode: null, kind: "work", pinned: false,
  lastLoggedAt: Math.floor(Date.now() / 1000), createdAt: null, archivedAt: null, path: "", depth, connectors: [], isLast: true,
})

function setup(extra: { scope?: string; branch?: string; linked?: string; context?: string; rows?: ContextRow[] } = {}) {
  const results: PickerResult[] = []
  let cancelled = false
  const tui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
  const keys: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down" }
  const kb = { matches: (d: string, id: string) => (keys[id] ? matchesKey(d, keys[id] as Parameters<typeof matchesKey>[1]) : false) } as unknown as KeybindingsManager
  const p = new ReviewPicker(tui, theme, kb, {
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
    saveRecencyDays: () => {},
  })
  const type = (s: string) => [...s].forEach((c) => p.handleInput(c))
  return { p, results, type, cancelled: () => cancelled }
}

describe("ReviewPicker", () => {
  test("without a match the highlight starts at the top", () => {
    const s = setup()
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "alpha", manifest: "default" }])
  })

  test("enter on a context reviews into it; tab cycles the manifest", () => {
    const s = setup()
    s.type("bet")
    s.p.handleInput("\t")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "beta", manifest: "quick" }])
  })

  test("review-<branch> is highlighted over <branch>", () => {
    const s = setup({ rows: [row("alpha"), row("t"), row("review-t")], scope: "o/r", branch: "t" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("without review-<branch> the branch context is highlighted", () => {
    const s = setup({ scope: "o/r", branch: "beta" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "beta", manifest: "default" }])
  })

  test("review-<linked> comes before the linked context, which comes before <branch>", () => {
    const rows = [row("alpha"), row("beta"), row("work"), row("review-work")]
    const a = setup({ rows, scope: "o/r", branch: "beta", linked: "o/r/work" })
    a.p.handleInput("\r")
    expect(a.results[0]!.context).toBe("review-work")
    const b = setup({ rows: rows.slice(0, 3), scope: "o/r", branch: "beta", linked: "o/r/work" })
    b.p.handleInput("\r")
    expect(b.results[0]!.context).toBe("work")
  })

  test("ctrl+n edits a prefilled name and creates under the highlighted context; esc backs out", () => {
    const s = setup({ scope: "o/r", branch: "beta" })
    s.p.handleInput("\x0e")
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(false)
    s.p.handleInput("\x0e")
    s.type("-2")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t-2", manifest: "default", parent: "o/r/beta" }])
  })

  test("ctrl+n refuses existing names and non-slugs", () => {
    const s = setup({ rows: [row("alpha"), row("review-t")], scope: "o/r" })
    s.p.handleInput("\x0e")
    s.p.handleInput("\r")
    expect(s.p.render(100).at(-1)).toContain("exists")
    s.type(" x")
    s.p.handleInput("\r")
    expect(s.p.render(100).at(-1)).toContain("slug")
    expect(s.results).toEqual([])
  })

  test("with no contexts ctrl+n creates at the top level", () => {
    const s = setup({ rows: [] })
    s.p.handleInput("\r")
    expect(s.results).toEqual([])
    s.p.handleInput("\x0e")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })
})
