import { describe, expect, test } from "bun:test"
import { contextAddressOf } from "./cue-session-link"

describe("contextAddressOf", () => {
  test("keeps a context address", () => {
    expect(contextAddressOf("org/repo/ctx")).toBe("org/repo/ctx")
  })

  test("reduces an artifact address to its context", () => {
    expect(contextAddressOf("org/repo/ctx/task/a.md")).toBe("org/repo/ctx")
    expect(contextAddressOf("org/repo/ctx/note/ideas/x.md")).toBe("org/repo/ctx")
  })

  test("trims whitespace and stray slashes", () => {
    expect(contextAddressOf(" org/repo/ctx/ ")).toBe("org/repo/ctx")
  })

  test("rejects non-canonical addresses", () => {
    expect(contextAddressOf("ctx")).toBeUndefined()
    expect(contextAddressOf("repo/ctx")).toBeUndefined()
    expect(contextAddressOf("org/../ctx")).toBeUndefined()
  })
})
