import { describe, expect, test } from "bun:test"
import { parseContextTree } from "./model"
import {
  groupSessions, inScopes, type SessionRow, scopeOf, scopeOfRemote, sessionMeta, transcript,
} from "./sessions"

let n = 0
const entry = (fields: Record<string, unknown>, parentId: string | null) => {
  const id = `e${++n}`
  return { id, line: JSON.stringify({ id, parentId, ...fields }) }
}

/** Build a linear session file from entry field objects. */
const file = (...fields: Record<string, unknown>[]): string => {
  let parent: string | null = null
  const lines = [JSON.stringify({ type: "session", cwd: "/w" })]
  for (const f of fields) {
    const e = entry(f, parent)
    parent = e.id
    lines.push(e.line)
  }
  return lines.join("\n")
}

const ctx = (address: string) => ({
  type: "custom_message", customType: "cue-context", details: { address },
})
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message", message: { role, content, ...extra },
})
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }

describe("sessionMeta", () => {
  test("takes the newest context, description and label", () => {
    const meta = sessionMeta(file(
      ctx("o/r/old"),
      { type: "custom", customType: "session-description", data: { text: "first" } },
      ctx("o/r/new"),
      { type: "custom", customType: "session-description", data: { text: " second " } },
      { type: "label", targetId: "x", label: "keep" },
      msg("assistant", [{ type: "text", text: "hi" }], { usage }),
    ))
    expect(meta).toMatchObject({ address: "o/r/new", description: "second", label: "keep" })
    expect(meta.tokens).toBeGreaterThan(0)
  })

  test("a cleared label hides older labels of the same target", () => {
    const meta = sessionMeta(file(
      { type: "label", targetId: "x", label: "old" },
      { type: "label", targetId: "x" },
    ))
    expect(meta.label).toBeUndefined()
    expect(meta.tokens).toBeNull()
  })

  test("skips aborted assistant usage", () => {
    const meta = sessionMeta(file(msg("assistant", "x", { usage, stopReason: "aborted" })))
    expect(meta.tokens).toBeNull()
  })
})

describe("transcript", () => {
  test("keeps user and assistant text, drops tools and thinking", () => {
    const md = transcript(file(
      msg("user", "do it"),
      msg("assistant", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "done" },
        { type: "toolCall", name: "bash" },
      ]),
      msg("toolResult", [{ type: "text", text: "output" }]),
      msg("assistant", [{ type: "toolCall", name: "bash" }]),
    ), "Title")
    expect(md).toBe("# Title\n\n---\n\n**you**\n\ndo it\n\n---\n\n**agent**\n\ndone")
  })
})

describe("scopeOf", () => {
  test("first two segments", () => expect(scopeOf("o/r/ctx")).toBe("o/r"))
})

describe("groupSessions", () => {
  const node = (context: string, children: unknown[] = []) => ({
    context, scope: "o/r", title: context, path: "", children,
  })
  const tree = parseContextTree(JSON.stringify({
    roots: [node("a", [node("b"), node("c")]), node("d")],
  }))
  const s = (path: string, address: string | undefined, modified: number): SessionRow => ({
    path, cwd: "/w", address, description: path, tokens: null, modified,
  })
  const sessions = [
    s("s1", "o/r/b", 1), s("s2", "o/r/b", 2), s("s3", "o/r/x", 3), s("s4", undefined, 4),
  ]
  const shape = (rows: ReturnType<typeof groupSessions>) =>
    rows.map((r) => (r.kind === "context" ? r.context.slug : `  ${r.session.path}`))

  test("keeps ancestors of contexts with sessions, sessions newest first", () => {
    expect(shape(groupSessions(tree, sessions, new Set(), false))).toEqual(["a", "b", "  s2", "  s1"])
  })

  test("orphans and sessions without a context come last", () => {
    expect(shape(groupSessions(tree, sessions, new Set(), true)))
      .toEqual(["a", "b", "  s2", "  s1", "x", "  s3", "(no context)", "  s4"])
  })

  test("folding hides only the context's own sessions", () => {
    const rows = groupSessions(tree, sessions, new Set(["o/r/b", "o/r/a"]), false)
    expect(shape(rows)).toEqual(["a", "b"])
    const b = rows[1]!
    expect(b.kind === "context" && b.sessions.length).toBe(2)
  })
})

describe("scopeOfRemote", () => {
  test("https, ssh and scp forms", () => {
    expect(scopeOfRemote("https://github.com/o/r.git")).toBe("o/r")
    expect(scopeOfRemote("ssh://git@github.com/o/r")).toBe("o/r")
    expect(scopeOfRemote("git@github.com:o/r.git\n")).toBe("o/r")
    expect(scopeOfRemote("nope")).toBeUndefined()
  })
})

describe("inScopes", () => {
  const s = (path: string, address?: string, cwd = "/w"): SessionRow => ({
    path, cwd, address, description: path, tokens: null, modified: 0,
  })
  test("context scope wins; cwd scope covers sessions without one", () => {
    const rows = [s("a", "o/r/x"), s("b", "z/z/x"), s("c"), s("d", undefined, "/other"), s("e", undefined, "")]
    const kept = inScopes(rows, new Set(["o/r"]), (cwd) => (cwd === "/w" ? "o/r" : "q/q"))
    expect(kept.map((r) => r.path)).toEqual(["a", "c"])
  })
})
