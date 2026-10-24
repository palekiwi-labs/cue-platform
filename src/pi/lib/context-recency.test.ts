import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  contextRecency,
  formatAge,
  recentArtifacts,
  renderChildrenTable,
  renderRecentArtifacts,
} from "./context-recency"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = 100 * DAY

describe("formatAge", () => {
  test("picks the coarsest unit", () => {
    expect(formatAge(NOW - 3 * DAY - HOUR, NOW)).toBe("3 days ago")
    expect(formatAge(NOW - DAY, NOW)).toBe("1 day ago")
    expect(formatAge(NOW - 5 * HOUR, NOW)).toBe("5 hours ago")
    expect(formatAge(NOW - 2 * MIN, NOW)).toBe("2 minutes ago")
    expect(formatAge(NOW - 1000, NOW)).toBe("just now")
  })
})

describe("renderChildrenTable", () => {
  test("aligns columns and adds the hint when a child is active", () => {
    const out = renderChildrenTable([
      { address: "a/b/long-child", logs: 12, artifacts: 3 },
      { address: "a/b/c", logs: 0, artifacts: 0 },
    ])
    expect(out).toBe(
      [
        "<children since-last-activity>",
        "child           logs  artifacts",
        "a/b/long-child    12          3",
        "a/b/c              0          0",
        "</children>",
        "Children above have logged work since this context's last activity;",
        "check their logs before answering about recent progress.",
      ].join("\n"),
    )
  })

  test("omits the hint when every child is quiet", () => {
    const out = renderChildrenTable([{ address: "a/b/c", logs: 0, artifacts: 0 }])
    expect(out).not.toContain("check their logs")
    expect(out).toContain("a/b/c")
  })

  test("is empty without children", () => {
    expect(renderChildrenTable([])).toBe("")
  })
})

describe("recentArtifacts", () => {
  test("dedupes by address, keeps newest first, ignores other kinds", () => {
    const items = recentArtifacts(
      [
        { timestamp: 1, kind: "artifact_created", details: { address: "x" } },
        { timestamp: 5, kind: "artifact_created", details: { address: "x" } },
        { timestamp: 3, kind: "artifact_created", details: { address: "y" } },
        { timestamp: 9, kind: "git_commit", details: {} },
      ],
      5,
    )
    expect(items).toEqual([
      { address: "x", timestamp: 5 },
      { address: "y", timestamp: 3 },
    ])
  })

  test("caps the list", () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((t) => ({
      timestamp: t,
      kind: "artifact_created",
      details: { address: `a${t}` },
    }))
    expect(recentArtifacts(events).map((i) => i.address)).toEqual([
      "a7", "a6", "a5", "a4", "a3",
    ])
  })

  test("renders aligned age and address", () => {
    const out = renderRecentArtifacts(
      [
        { address: "s/c/task/a.md", timestamp: NOW - 2 * DAY },
        { address: "s/c/trace/h.md", timestamp: NOW - 30 * DAY },
      ],
      NOW,
    )
    expect(out).toBe(
      [
        "<recent-artifacts>",
        "2 days ago   s/c/task/a.md",
        "30 days ago  s/c/trace/h.md",
        "</recent-artifacts>",
      ].join("\n"),
    )
  })
})

/**
 * Fake store: contexts with parent links, log timestamps (ms) and
 * artifact_created events (ms). Answers the cue calls contextRecency
 * makes, honouring --since.
 */
function fakePi(store: {
  children: Record<string, string[]>
  logs: Record<string, number[]>
  artifacts: Record<string, number[]>
}): ExtensionAPI {
  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 })
  return {
    exec: async (_cmd: string, args: string[]) => {
      const ctx = args[args.indexOf("--context") + 1] ?? ""
      if (args[0] === "context") {
        const parent = args[args.length - 1]!.replace("parent=", "")
        return ok((store.children[parent] ?? []).join("\n"))
      }
      if (args[0] === "log") {
        const entries = (store.logs[ctx] ?? []).map((ms) => ({
          timestamp: ms * 1_000_000,
        }))
        return ok(JSON.stringify(entries))
      }
      if (args[0] === "activity") {
        const i = args.indexOf("--since")
        const since = i >= 0 ? Number(args[i + 1]) : -Infinity
        const events = (store.artifacts[ctx] ?? [])
          .filter((t) => t >= since)
          .map((t) => ({
            timestamp: t,
            kind: "artifact_created",
            details: { address: `${ctx}/note/n${t}.md` },
          }))
        return ok(JSON.stringify(events))
      }
      return { stdout: "", stderr: "boom", code: 1 }
    },
  } as unknown as ExtensionAPI
}

describe("contextRecency", () => {
  test("counts child and grandchild work since the last log entry", async () => {
    const last = NOW - 14 * DAY
    const pi = fakePi({
      children: { "s/top": ["s/a", "s/b"], "s/a": ["s/a1"] },
      logs: {
        "s/top": [last - DAY, last],
        "s/a": [last - DAY, last + HOUR],
        "s/a1": [last + 2 * HOUR, last + 3 * HOUR],
        "s/b": [last - 2 * DAY],
      },
      artifacts: {
        "s/top": [last - 5 * DAY],
        "s/a": [last, last + HOUR],
        "s/a1": [last + 2 * HOUR],
      },
    })
    const { recency, artifacts } = await contextRecency(pi, "/w", "s/top", NOW)
    expect(recency).toContain("Last activity: 14 days ago")
    expect(recency).toContain("s/a       3          2")
    expect(recency).toContain("s/b       0          0")
    expect(recency).toContain("check their logs")
    expect(artifacts).toBe(
      "<recent-artifacts>\n19 days ago  s/top/note/n" +
        String(last - 5 * DAY) +
        ".md\n</recent-artifacts>",
    )
  })

  test("without a log, everything in the children counts", async () => {
    const pi = fakePi({
      children: { "s/top": ["s/a"] },
      logs: { "s/a": [NOW - DAY] },
      artifacts: {},
    })
    const { recency, artifacts } = await contextRecency(pi, "/w", "s/top", NOW)
    expect(recency).toContain("Last activity: none (no log entries)")
    expect(recency).toContain("s/a       1          0")
    expect(artifacts).toBe("")
  })

  test("a context with no children shows only the last-activity line", async () => {
    const pi = fakePi({ children: {}, logs: { "s/top": [NOW - HOUR] }, artifacts: {} })
    const { recency } = await contextRecency(pi, "/w", "s/top", NOW)
    expect(recency).toBe("Last activity: 1 hour ago")
  })
})
