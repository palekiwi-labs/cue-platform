import { expect, test } from "bun:test"
import { shownContexts } from "./context-list"
import { parseContextTree } from "./model"

const rows = parseContextTree(JSON.stringify({ roots: [{
  context: "parent", scope: "org/repo", children: [{
    context: "child", scope: "org/repo", children: [],
  }],
}] }))
const folds = new Set(["org/repo/parent"])

test("contexts default to folded tree; flat ignores and preserves folds", () => {
  expect(shownContexts(rows, "", rows, folds).map(r => r.slug)).toEqual(["parent"])
  expect(shownContexts(rows, "", rows, folds, true).map(r => r.slug)).toEqual(["parent", "child"])
  expect(shownContexts(rows, "", rows, folds).map(r => r.slug)).toEqual(["parent"])
})

test("flat recent omits ancestor-only rows, queries still search all contexts", () => {
  const recent = rows.map(r => ({ ...r, ancestorOnly: r.slug === "parent" }))
  expect(shownContexts(rows, "", recent, folds, true).map(r => r.slug)).toEqual(["child"])
  expect(shownContexts(rows, "parent", recent, folds, true).map(r => r.slug)).toEqual(["parent"])
})
