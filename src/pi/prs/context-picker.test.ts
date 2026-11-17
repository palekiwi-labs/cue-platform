import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, type TUI } from "@earendil-works/pi-tui"
import type { ContextRow } from "../browser/model"
import type { Pr } from "./model"
import { type PickerResult, ContextPicker } from "./context-picker"

const row = (slug: string, depth = 0): ContextRow => ({
  address: `o/r/${slug}`, scope: "o/r", slug, title: slug, mode: null, kind: "work", pinned: false,
  lastLoggedAt: Math.floor(Date.now() / 1000), createdAt: null, archivedAt: null, path: "", depth, connectors: [], isLast: true,
})

function setup(extra: {
  purpose?: "review" | "parent"; scope?: string; branch?: string; linked?: string; here?: string; context?: string; rows?: ContextRow[]
} = {}) {
  const results: PickerResult[] = []
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
    saveRecencyDays: () => {},
  })
  const type = (s: string) => [...s].forEach((c) => p.handleInput(c))
  return { p, results, type, cancelled: () => cancelled }
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

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })
})
