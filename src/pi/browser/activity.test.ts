import { describe, expect, test } from "bun:test"
import {
  artifactPath,
  commitDetails,
  eventPreview,
  eventSummary,
  fmtWhen,
  kindLabel,
  parseActivity,
  sortActivity,
} from "./activity"

const event = {
  id: "x1",
  timestamp: 1792853548099,
  kind: "git_commit",
  host: "pale",
  sessionId: "01a16e35-ceed",
  session_id: "01a16e35-ceed",
  harness: "pi",
  details: {
    hash: "e523bf906239348bd8590a6a9435d4c03b489c86",
    branch: "master",
    title: "test: non-quiet dummy commit",
    repo: null,
    root: "/tmp/activity-check2",
  },
}

describe("parseActivity", () => {
  test("parses events and drops malformed ones", () => {
    const out = parseActivity(
      JSON.stringify([event, { id: "bad" }, { kind: "no-id" }, "nope"]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.sessionId).toBe("01a16e35-ceed")
    expect(out[0]!.details.title).toBe("test: non-quiet dummy commit")
  })
  test("empty and broken input give an empty list", () => {
    expect(parseActivity("")).toEqual([])
    expect(parseActivity("{")).toEqual([])
    expect(parseActivity('{"a":1}')).toEqual([])
  })
  test("sortActivity is newest first and stable", () => {
    const a = { id: "a", timestamp: 2, kind: "k", host: null, harness: null, sessionId: null, details: {} }
    const b = { id: "b", timestamp: 3, kind: "k", host: null, harness: null, sessionId: null, details: {} }
    const c = { id: "c", timestamp: 3, kind: "k", host: null, harness: null, sessionId: null, details: {} }
    expect(sortActivity([a, b, c]).map((e) => e.id)).toEqual(["b", "c", "a"])
  })
})

describe("kindLabel", () => {
  test("known kinds get labels and colours", () => {
    expect(kindLabel("git_commit").label).toBe("COMMIT")
    expect(kindLabel("artifact_created").label).toBe("ARTIFACT")
    expect(kindLabel("session_associated").label).toBe("SESSION")
  })
  test("unknown kinds render raw and dim, truncated", () => {
    expect(kindLabel("deploy_hook")).toEqual({ label: "deploy_h", color: "dim" })
  })
})

describe("fmtWhen", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0)
  test("same day shows the time", () => {
    expect(fmtWhen(now - 3 * 3600_000, now)).toMatch(/today \d\d:\d\d/)
  })
  test("past days show the count", () => {
    expect(fmtWhen(now - 3 * 86400_000, now)).toMatch(/^3d /)
  })
  test("past a week shows the date", () => {
    expect(fmtWhen(now - 20 * 86400_000, now)).toMatch(/^\d{4}-\d\d-\d\d$/)
  })
})

describe("eventSummary", () => {
  test("commit title wins for git_commit", () => {
    expect(eventSummary(event as any)).toBe("test: non-quiet dummy commit")
  })
  test("artifact address for artifact_created", () => {
    const e = { ...event, kind: "artifact_created", details: { address: "a/b/c/note/x.md", type: "note" } } as any
    expect(eventSummary(e)).toBe("a/b/c/note/x.md")
  })
  test("method for session_associated", () => {
    const e = { ...event, kind: "session_associated", details: { method: "link" } } as any
    expect(eventSummary(e)).toBe("session link")
  })
  test("details JSON as fallback", () => {
    const e = { ...event, kind: "custom_thing", details: { a: 1 } } as any
    expect(eventSummary(e)).toBe('{"a":1}')
  })
})

describe("commitDetails", () => {
  test("requires a hash", () => {
    expect(commitDetails(event as any)!.hash.slice(0, 6)).toBe("e523bf")
    const legacy = { ...event, details: { command: "git commit", cwd: "/x" } } as any
    expect(commitDetails(legacy)).toBeNull()
  })
})

describe("eventPreview", () => {
  test("commit with diff", () => {
    const md = eventPreview(event as any, { gitShow: "diff --git a/x\n+b" })
    expect(md).toBe("```diff\ndiff --git a/x\n+b\n```")
  })
  test("commit without a diff notes it", () => {
    const md = eventPreview(event as any, {})
    expect(md).toContain("_commit not found on this host_")
  })
  test("legacy commit without hash shows the command", () => {
    const e = { ...event, details: { command: "git commit -m x", cwd: "/x" } } as any
    expect(eventPreview(e)).toContain("git commit -m x")
  })
  test("artifact shows frontmatter and body", () => {
    const e = {
      ...event, kind: "artifact_created",
      details: { address: "a/b/c/note/x.md", type: "note" },
    } as any
    const md = eventPreview(e, { artifact: "---\nstatus: open\n---\n\nBody text." })
    expect(md).toBe("```yaml\nstatus: open\n```\n\nBody text.")
  })
  test("artifact missing from the store notes it", () => {
    const e = { ...event, kind: "artifact_created", details: { address: "a" } } as any
    expect(eventPreview(e)).toContain("_artifact not found in this store_")
  })
  test("session preview or fallback", () => {
    const e = { ...event, kind: "session_associated", details: { method: "link" } } as any
    expect(eventPreview(e, { sessionPreview: "# the talk" })).toBe("# the talk")
    expect(eventPreview(e)).toContain("_session file not found on this host_")
  })
  test("unknown kind shows details JSON", () => {
    const e = { ...event, kind: "custom", details: { a: 1 } } as any
    expect(eventPreview(e)).toContain("```json")
  })
  test("long diffs are capped", () => {
    const long = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n")
    const md = eventPreview(event as any, { gitShow: long })
    expect(md).toContain("more lines")
  })
})

describe("artifactPath", () => {
  test("store root plus address", () => {
    const e = { ...event, kind: "artifact_created", details: { address: "a/b" } } as any
    expect(artifactPath(e, "/home/pl/cue")).toBe("/home/pl/cue/a/b")
    expect(artifactPath({ ...e, details: {} } as any, "/x")).toBeNull()
  })
})
