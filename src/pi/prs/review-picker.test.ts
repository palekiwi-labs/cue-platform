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

function setup(extra: { link?: boolean; selected?: string; scope?: string; linked?: string; context?: string; rows?: ContextRow[] } = {}) {
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
  test("enter on the default row starts without a parent", () => {
    const s = setup()
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("typing fuzzy-selects the best match as parent", () => {
    const s = setup()
    s.type("bet")
    s.p.handleInput("\r")
    expect(s.results[0]!.parent).toBe("o/r/beta")
  })

  test("down moves through the tree; tab cycles the manifest", () => {
    const s = setup()
    s.p.handleInput("\x1b[B")
    s.p.handleInput("\t")
    s.p.handleInput("\r")
    expect(s.results[0]).toEqual({ context: "review-t", manifest: "quick", parent: "o/r/alpha" })
  })

  test("ctrl+e edits the context; esc undoes, invalid slugs are refused", () => {
    const s = setup()
    s.p.handleInput("\x05")
    s.type(" x")
    s.p.handleInput("\r")
    expect(s.p.render(80).at(-1)).toContain("slug")
    s.p.handleInput("\x1b")
    s.p.handleInput("\x05")
    s.type("-2")
    s.p.handleInput("\r")
    s.p.handleInput("\r")
    expect(s.results[0]!.context).toBe("review-t-2")
    expect(s.cancelled()).toBe(false)
  })

  test("an existing review context keeps its parent; others are refused", () => {
    const rows = [row("alpha"), row("beta"), { ...row("review-t"), parent: "o/r/alpha" }]
    const s = setup({ rows, scope: "o/r", selected: "o/r/beta" })
    expect(s.p.render(120).join("\n")).toContain("exists under o/r/alpha")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default", parent: "o/r/alpha" }])
    s.p.handleInput("\x1b[B")
    s.p.handleInput("\r")
    expect(s.results).toHaveLength(1)
    expect(s.p.render(120).at(-1)).toContain("ctrl+e")
  })

  test("an existing review context without a parent starts with none", () => {
    const s = setup({ rows: [row("alpha"), row("review-t")], scope: "o/r" })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", manifest: "default" }])
  })

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })

  test("link: enter on a context links it", () => {
    const s = setup({ link: true })
    s.type("bet")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "o/r/beta" }])
  })

  test("link: first row creates the named context without a parent", () => {
    const s = setup({ link: true })
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "review-t", create: true }])
  })

  test("link: ctrl+n creates under the highlighted context", () => {
    const s = setup({ link: true })
    s.p.handleInput("\x1b[B")
    s.p.handleInput("\x0e")
    expect(s.results).toEqual([{ context: "review-t", create: true, parent: "o/r/alpha" }])
  })

  test("link: an existing context named like the branch is linked, not created", () => {
    const s = setup({ link: true, scope: "o/r", context: "beta" })
    expect(s.p.render(100).join("\n")).toContain("link existing: o/r/beta")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "o/r/beta" }])
  })

  test("link: ctrl+n refuses a name that exists", () => {
    const s = setup({ link: true, scope: "o/r", context: "beta" })
    s.p.handleInput("\x0e")
    expect(s.results).toEqual([])
    expect(s.p.render(100).at(-1)).toContain("exists")
  })

  test("link: a linked branch shows its link and has no create row", () => {
    const s = setup({ link: true, scope: "o/r", context: "beta", linked: "o/r/beta", selected: "o/r/beta" })
    const out = s.p.render(100).join("\n")
    expect(out).toContain("linked o/r/beta")
    expect(out).not.toContain("(new:")
    s.p.handleInput("\r")
    expect(s.results).toEqual([])
    s.p.handleInput("\x1b[A")
    s.p.handleInput("\r")
    expect(s.results).toEqual([{ context: "o/r/alpha" }])
  })

  test("selected preselects a context", () => {
    const s = setup({ selected: "o/r/beta" })
    s.p.handleInput("\r")
    expect(s.results[0]!.parent).toBe("o/r/beta")
  })
})
