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

function setup(extra: { scope?: string; linked?: string; context?: string; rows?: ContextRow[] } = {}) {
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
  test("enter on the first row reviews into the named context", () => {
    const s = setup()
    expect(s.p.render(100).join("\n")).toContain("(new: review-t, top level)")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("enter on a context reviews into it; tab cycles the manifest", () => {
    const s = setup()
    s.type("bet")
    s.p.handleInput("\t")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "beta", manifest: "quick" }])
  })

  test("an existing named context is highlighted over the linked one", () => {
    const s = setup({ rows: [row("alpha"), row("review-t")], scope: "o/r", linked: "o/r/alpha" })
    expect(s.p.render(100).join("\n")).toContain("(existing: o/r/review-t)")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("without the named context the linked one is highlighted", () => {
    const s = setup({ scope: "o/r", linked: "o/r/beta" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "beta", manifest: "default" }])
  })

  test("ctrl+n edits a prefilled name and creates under the highlighted context", () => {
    const s = setup({ scope: "o/r", linked: "o/r/alpha" })
    s.p.handleInput("\x0e")
    expect(s.results).toEqual([])
    s.type("-2")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t-2", manifest: "default", parent: "o/r/alpha" }])
  })

  test("ctrl+n on the first row creates at the top level; esc backs out", () => {
    const s = setup()
    s.p.handleInput("\x0e")
    s.p.handleInput("\x1b")
    expect(s.results).toEqual([])
    expect(s.cancelled()).toBe(false)
    s.p.handleInput("\x0e")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
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

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })
})
