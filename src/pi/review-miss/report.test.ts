import { describe, expect, test } from "bun:test"
import { addressOf, missTrace, repoIdOf } from "./report"

describe("missTrace", () => {
  test("titles the trace from the comment's first line and records the session", () => {
    const t = missTrace({
      comment: "Verifier refuted the N+1 query\nteammate flagged it on the PR",
      cwd: "/repo",
      date: new Date(2026, 10, 12),
      sessionFile: "/s/session.jsonl",
      sessionId: "abc",
      transcript: "o/r/review-misses/tmp/1-x/session.jsonl",
    })
    expect(t.filename).toBe("2026-11-12-verifier-refuted-the-n-1-query.md")
    expect(t.frontmatter).toEqual({
      status: "open",
      title: "Verifier refuted the N+1 query",
      cwd: "/repo",
      session_id: "abc",
      session_file: "/s/session.jsonl",
      transcript: "o/r/review-misses/tmp/1-x/session.jsonl",
    })
    expect(t.body).toContain("teammate flagged it on the PR")
  })

  test("omits session fields when absent", () => {
    const t = missTrace({ comment: "x", cwd: "/repo", date: new Date(2026, 0, 1) })
    expect(Object.keys(t.frontmatter)).toEqual(["status", "title", "cwd"])
  })
})

test("addressOf strips the store root", () => {
  expect(addressOf("/home/u/cue/o/r/c/tmp/1-x/session.jsonl", "/home/u/cue")).toBe("o/r/c/tmp/1-x/session.jsonl")
})

test("repoIdOf parses ssh and https remotes", () => {
  expect(repoIdOf("git@github.com:palekiwi-labs/cue.git")).toBe("palekiwi-labs/cue")
  expect(repoIdOf("https://github.com/spabreaks/spabreaks")).toBe("spabreaks/spabreaks")
})
