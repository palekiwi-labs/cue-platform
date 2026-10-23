import { describe, expect, test } from "bun:test"
import {
  type ArtifactRow,
  parseArtifacts,
  parseContextTree,
  relativeAge,
  sortArtifacts,
  treePrefix,
} from "./model"

const node = (context: string, extra: Record<string, unknown> = {}) => ({
  context,
  scope: "org/repo",
  title: context.toUpperCase(),
  kind: "work",
  mode: "build",
  pinned: false,
  last_logged_at: 100,
  path: `/store/org/repo/${context}/context.md`,
  children: [],
  ...extra,
})

describe("parseContextTree", () => {
  test("flattens in CLI order with depth and connectors", () => {
    const json = JSON.stringify({
      roots: [
        node("a", { children: [node("b", { children: [node("c")] }), node("d")] }),
        node("e", { pinned: true, mode: null, last_logged_at: null }),
      ],
    })
    const rows = parseContextTree(json)
    expect(rows.map((r) => r.slug)).toEqual(["a", "b", "c", "d", "e"])
    expect(rows.map(treePrefix)).toEqual(["", "├─", "│ └─", "└─", ""])
    expect(rows[0]!.address).toBe("org/repo/a")
    expect(rows[4]!).toMatchObject({ pinned: true, mode: null, lastLoggedAt: null })
  })

  test("drops malformed nodes and survives bad JSON", () => {
    expect(parseContextTree("nope")).toEqual([])
    const rows = parseContextTree(
      JSON.stringify({ roots: [{ scope: "x" }, node("ok")] }),
    )
    expect(rows.map((r) => r.slug)).toEqual(["ok"])
  })
})

describe("parseArtifacts", () => {
  test("reads frontmatter and falls back to name", () => {
    const rows = parseArtifacts(
      JSON.stringify([
        {
          path: "/s/o/r/c/task/x.md",
          name: "x.md",
          type: "task",
          frontmatter: { title: "X", status: "open", priority: "high", created_at: 5 },
        },
        { path: "/s/o/r/c/note/y.md", name: "y.md", type: "note" },
        { name: "broken" },
      ]),
    )
    expect(rows).toEqual([
      { path: "/s/o/r/c/task/x.md", name: "x.md", type: "task", title: "X", status: "open", priority: "high", createdAt: 5 },
      { path: "/s/o/r/c/note/y.md", name: "y.md", type: "note", title: "y.md", status: null, priority: null, createdAt: null },
    ])
  })

  test("takes tmp creation time from the path", () => {
    const [row] = parseArtifacts(
      JSON.stringify([
        { path: "/s/c/tmp/1792769248000000000-abc1234/d.diff", name: "d.diff", type: "tmp" },
      ]),
    )
    expect(row!.createdAt).toBe(1792769248)
  })
})

describe("sortArtifacts", () => {
  const a = (type: string, title: string, status: string | null, createdAt: number): ArtifactRow => ({
    path: `/${type}/${title}`, name: title, type, title, status, priority: null, createdAt,
  })
  test("type order, unfinished first, newest first", () => {
    const sorted = sortArtifacts([
      a("note", "n1", null, 1),
      a("task", "done", "complete", 9),
      a("task", "old", "open", 1),
      a("task", "new", "open", 5),
      a("weird", "w", null, 1),
      a("spec", "index.md", null, 1),
    ])
    expect(sorted.map((r) => r.title)).toEqual(["new", "old", "done", "index.md", "n1", "w"])
  })
})

describe("relativeAge", () => {
  test("compact units", () => {
    expect(relativeAge(null, 0)).toBe("—")
    expect(relativeAge(100, 130)).toBe("now")
    expect(relativeAge(0, 12 * 60)).toBe("12m")
    expect(relativeAge(0, 3 * 3600)).toBe("3h")
    expect(relativeAge(0, 6 * 86400)).toBe("6d")
    expect(relativeAge(0, 400 * 86400)).toBe("1y")
  })
})
