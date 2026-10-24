import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, type TUI } from "@earendil-works/pi-tui"
import type { ContextRow } from "../browser/model"
import type { Pr } from "./model"
import { type PickerResult, ReviewPicker } from "./review-picker"

const row = (slug: string, depth = 0): ContextRow => ({
  address: `o/r/${slug}`, scope: "o/r", slug, title: slug, mode: null, kind: "work", pinned: false,
  lastLoggedAt: Math.floor(Date.now() / 1000), createdAt: null, path: "", depth, connectors: [], isLast: true,
})

function setup() {
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

  test("esc goes back", () => {
    const s = setup()
    s.p.handleInput("\x1b")
    expect(s.cancelled()).toBe(true)
  })
})
