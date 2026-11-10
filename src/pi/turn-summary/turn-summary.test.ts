import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoSummary, setAutoSummary } from "./settings"
import { cleanSummary } from "./clean"
import { feedbackNote } from "./feedback"
import { storedSummaries, TURN_SUMMARY_TYPE, turnsOf } from "./turns"

const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } })
const assistant = (id: string, ...parts: { type: string; text?: string }[]) => ({
  type: "message",
  id,
  message: { role: "assistant", content: parts },
})

describe("turnsOf", () => {
  test("groups assistant text under the user message that started the turn", () => {
    const turns = turnsOf([
      user("u1", "first"),
      assistant("a1", { type: "thinking", text: "hmm" }, { type: "text", text: "one" }),
      assistant("a2", { type: "toolCall" }, { type: "text", text: "two" }),
      user("u2", "second"),
      assistant("a3", { type: "text", text: "three" }),
    ])
    expect(turns).toEqual([
      { id: "u1", prompt: "first", text: "one\n\ntwo" },
      { id: "u2", prompt: "second", text: "three" },
    ])
  })

  test("skips turns without assistant text", () => {
    expect(turnsOf([user("u1", "x"), assistant("a1", { type: "toolCall" })])).toEqual([])
  })
})

describe("storedSummaries", () => {
  test("maps turn ids to stored text, newest wins", () => {
    const entry = (id: string, turnId: string, text: string) => ({
      type: "custom",
      id,
      customType: TURN_SUMMARY_TYPE,
      data: { turnId, text },
    })
    const map = storedSummaries([entry("c1", "u1", "old"), entry("c2", "u1", "new"), entry("c3", "u2", "b")])
    expect(map.get("u1")?.text).toBe("new")
    expect(map.get("u2")?.text).toBe("b")
  })
})

describe("cleanSummary", () => {
  test("strips markdown, code, paths and urls", () => {
    const raw = [
      "## Done",
      "",
      "- I **fixed** the `parser` in src/pi/lib/parse.ts and ./README.md.",
      "- See https://example.com/x for [details](https://example.com).",
      "```ts\nconst x = 1\n```",
      "Tests pass.",
    ].join("\n")
    expect(cleanSummary(raw)).toBe("Done I fixed the parser in and See for details. Tests pass.")
  })

  test("leaves plain prose alone", () => {
    const prose = "I updated the parser so empty input no longer crashes, and the tests pass."
    expect(cleanSummary(prose)).toBe(prose)
  })
})

describe("auto summary setting", () => {
  test("is off by default and persists when toggled", () => {
    const file = join(mkdtempSync(join(tmpdir(), "turn-summary-")), "state.json")
    expect(autoSummary(file)).toBe(false)
    setAutoSummary(true, file)
    expect(autoSummary(file)).toBe(true)
    setAutoSummary(false, file)
    expect(autoSummary(file)).toBe(false)
  })
})

describe("feedbackNote", () => {
  const report = {
    comment: "Drops context talk!\nMore detail here.",
    summary: { turnId: "u1", text: "My context is full.", model: "m", promptHash: "abc123", runId: "r1" },
    input: "<assistant-output>\n```ts\nx\n```\n</assistant-output>",
    sessionFile: "/s.jsonl",
    cwd: "/w",
    date: new Date(2026, 10, 10),
  }

  test("names the note after the date and the comment's first line", () => {
    const note = feedbackNote(report)
    expect(note.filename).toBe("summarizer-feedback/2026-11-10-drops-context-talk.md")
    expect(note.frontmatter).toEqual({
      status: "open",
      title: "Drops context talk!",
      turn_id: "u1",
      cwd: "/w",
      model: "m",
      prompt_hash: "abc123",
      run_id: "r1",
      session_file: "/s.jsonl",
    })
  })

  test("fences the input with a fence longer than any backtick run inside it", () => {
    const body = feedbackNote(report).body
    expect(body).toStartWith("## Comment\n\nDrops context talk!\nMore detail here.\n")
    expect(body).toContain("## Input\n\n````\n<assistant-output>")
    expect(body).toContain("## Summary\n\n```\nMy context is full.\n```")
  })
})
