import { expect, test } from "bun:test"
import { shownContexts } from "./context-list"
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
