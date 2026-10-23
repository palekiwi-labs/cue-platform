import { describe, expect, test } from "bun:test"
import { contextCreateFlags } from "./cue-context-helpers"

describe("contextCreateFlags", () => {
  test("emits each provided field as its own flag pair", () => {
    expect(
      contextCreateFlags({
        title: "Auth Redesign",
        kind: "work",
        mode: "build",
        description: "Rework auth",
        parent: "palekiwi/palekiwi/platform",
      }),
    ).toEqual([
      "--title",
      "Auth Redesign",
      "--kind",
      "work",
      "--mode",
      "build",
      "--description",
      "Rework auth",
      "--parent",
      "palekiwi/palekiwi/platform",
    ])
  })

  test("blank strings are dropped, not forwarded", () => {
    expect(contextCreateFlags({ title: "  ", kind: "work" })).toEqual([
      "--kind",
      "work",
    ])
  })

  test("refs emit one --ref pair each", () => {
    expect(contextCreateFlags({ refs: ["a/b", "c/d"] })).toEqual([
      "--ref",
      "a/b",
      "--ref",
      "c/d",
    ])
  })

  test("absent refs emit nothing", () => {
    expect(contextCreateFlags({ title: "T" })).toEqual(["--title", "T"])
  })

  test("prose with quotes and newlines survives as a single argv entry", () => {
    const flags = contextCreateFlags({ description: 'say "hi"\nnewline' })
    expect(flags).toEqual(["--description", 'say "hi"\nnewline'])
  })
})
