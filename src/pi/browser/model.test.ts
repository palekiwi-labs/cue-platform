import { describe, expect, test } from "bun:test"
import {
  type ArtifactRow,
  parseArtifacts,
  parseContextTree,
  relativeAge,
  sortArtifacts,
  treePrefix,
  artifactAddress,
  artifactFilename,
  collapseTree,
  filterRecent,
  pinnedFirst,
  recencyIndex,
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

  test("reads archived_at", () => {
    const rows = parseContextTree(
      JSON.stringify({ roots: [node("a", { archived_at: 42 }), node("b", { archived_at: null })] }),
    )
    expect(rows.map((r) => r.archivedAt)).toEqual([42, null])
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

describe("artifactAddress", () => {
  test("strips the store root", () => {
    expect(artifactAddress("org/repo/ctx", "/store/org/repo/ctx/note/ideas/a.md"))
      .toBe("org/repo/ctx/note/ideas/a.md")
  })
  test("undefined outside the context", () => {
    expect(artifactAddress("org/repo/ctx", "/store/org/repo/other/note/a.md")).toBeUndefined()
  })
})

describe("artifactFilename", () => {
  test("slug mode flattens to one segment", () => {
    expect(artifactFilename("My Idea/Two", false)).toBe("my-idea-two.md")
  })
  test("path mode keeps nesting", () => {
    expect(artifactFilename("ideas/My Idea.md", true)).toBe("ideas/my-idea.md")
  })
  test("non-markdown keeps its extension", () => {
    expect(artifactFilename("Dump.json", false, false)).toBe("dump.json")
  })
  test("rejects empty and escapes", () => {
    expect(artifactFilename("  ", false)).toBeUndefined()
    expect(artifactFilename("../x", true)).toBeUndefined()
  })
})

describe("collapseTree", () => {
  const rows = parseContextTree(JSON.stringify({
    roots: [
      node("a", { children: [node("b", { children: [node("c")] }), node("d")] }),
      node("e"),
    ],
  }))

  test("hides descendants of collapsed rows and counts them", () => {
    const { rows: shown, hidden } = collapseTree(rows, new Set(["org/repo/a"]))
    expect(shown.map((r) => r.slug)).toEqual(["a", "e"])
    expect(hidden.get("org/repo/a")).toBe(3)
  })

  test("nested collapse counts only its own subtree", () => {
    const { rows: shown, hidden } = collapseTree(rows, new Set(["org/repo/b"]))
    expect(shown.map((r) => r.slug)).toEqual(["a", "b", "d", "e"])
    expect(hidden.get("org/repo/b")).toBe(1)
    expect(hidden.has("org/repo/e")).toBe(false)
  })
})

describe("filterRecent", () => {
  const DAY = 86400
  const now = 100 * DAY
  // root (old) > mid (old) > leaf (recent); root > stale (old); fresh (created recently, never logged)
  const tree = () => parseContextTree(JSON.stringify({
    roots: [
      node("root", {
        last_logged_at: 10 * DAY,
        children: [
          node("mid", { last_logged_at: 10 * DAY, children: [node("leaf", { last_logged_at: now - DAY })] }),
          node("stale", { last_logged_at: 10 * DAY }),
        ],
      }),
      node("busy", { last_logged_at: now, children: [node("quiet", { last_logged_at: 10 * DAY })] }),
      node("fresh", { last_logged_at: null, created_at: now - 3600 }),
      node("pin", { last_logged_at: 1, pinned: true }),
      node("gone", { last_logged_at: 1 }),
    ],
  }))

  test("keeps recent and pinned contexts plus all their ancestors", () => {
    const rows = filterRecent(tree(), now, 3)
    expect(rows.map((r) => r.slug)).toEqual(["root", "mid", "leaf", "busy", "fresh", "pin"])
    expect(rows.filter((r) => r.ancestorOnly).map((r) => r.slug)).toEqual(["root", "mid"])
  })

  test("recomputes tree connectors after pruning", () => {
    const rows = filterRecent(tree(), now, 3)
    const mid = rows.find((r) => r.slug === "mid")!
    expect(mid.isLast).toBe(true)
    expect(rows.find((r) => r.slug === "pin")!.isLast).toBe(true)
  })

  test("extra activity counts like a log entry", () => {
    const rows = filterRecent(tree(), now, 3, new Map([["org/repo/gone", now]]))
    expect(rows.map((r) => r.slug)).toContain("gone")
  })
})

describe("pinnedFirst", () => {
  test("moves pinned siblings first, keeping order otherwise", () => {
    const rows = parseContextTree(JSON.stringify({
      roots: [node("a"), node("b", { pinned: true, children: [node("c"), node("d", { pinned: true })] }), node("e")],
    }))
    expect(pinnedFirst(rows).map((r) => r.slug)).toEqual(["b", "d", "c", "a", "e"])
  })
})

describe("recencyIndex", () => {
  test("maps stored days to a step, defaulting to 3 days", () => {
    expect(recencyIndex(7)).toBe(3)
    expect(recencyIndex(undefined)).toBe(2)
    expect(recencyIndex(5)).toBe(2)
  })
})
