import { expect, test } from "bun:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { contextLine, shownContexts } from "./context-list"
import { parseContextTree, sortFlatContexts } from "./model"

const rows = parseContextTree(JSON.stringify({ roots: [{
  context: "parent", scope: "org/repo", children: [{
    context: "child", scope: "org/repo", children: [],
  }],
}] }))
const folds = new Set(["org/repo/parent"])

test("contexts default to folded tree; flat ignores and preserves folds", () => {
  expect(shownContexts(rows, "", rows, folds).map(r => r.slug)).toEqual(["parent"])
  expect(shownContexts(rows, "", rows, folds, true).map(r => r.slug)).toEqual(["child", "parent"])
  expect(shownContexts(rows, "", rows, folds).map(r => r.slug)).toEqual(["parent"])
})

test("flat recent omits ancestor-only rows, queries respect the recency window", () => {
  const recent = rows.map(r => ({ ...r, ancestorOnly: r.slug === "parent" }))
  expect(shownContexts(rows, "", recent, folds, true).map(r => r.slug)).toEqual(["child"])
  expect(shownContexts(rows, "parent", recent, folds, true).map(r => r.slug)).toEqual([])
  expect(shownContexts(rows, "parent", rows, folds, true).map(r => r.slug)).toEqual(["parent"])
})

test("flat lists sort by pinned then recency, never-logged last", () => {
  const mk = (slug: string, lastLoggedAt: number | null, pinned = false) =>
    ({ ...rows[1]!, slug, address: `org/repo/${slug}`, pinned, lastLoggedAt }) as typeof rows[number]
  const list = [mk("old", 100), mk("never", null), mk("new", 300), mk("pinned", 50, true)]
  expect(sortFlatContexts(list).map(r => r.slug)).toEqual(["pinned", "new", "old", "never"])
})

test("a cut slug emits no ANSI reset, so the selection background survives", () => {
  const theme = { fg: (_: string, s: string) => `\x1b[2m${s}\x1b[22m` } as never
  const long = { ...rows[1]!, slug: "a-very-long-context-slug-that-does-not-fit" }
  const opts = { tree: true, here: undefined, mixed: false, hidden: new Map(), now: 0 }
  const line = contextLine(theme, long, { ...opts, slugWidth: 60, width: 80 })
  expect(line).not.toContain("\x1b[0m")
  expect(line).toContain("…")
  expect(visibleWidth(line)).toBe(80)
  // Wide rows lift the 40-column cap: the slug fits at 45% of 120.
  const wide = contextLine(theme, long, { ...opts, slugWidth: 50, width: 120 })
  expect(wide).toContain(long.slug)
})
