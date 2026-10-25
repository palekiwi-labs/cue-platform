import { describe, expect, test } from "bun:test"
import { defaultTarget } from "./default-target"

describe("defaultTarget", () => {
  test("is here for an empty session", () => {
    expect(defaultTarget([])).toBe("here")
  })

  test("is here when only custom messages were injected", () => {
    expect(defaultTarget([{ type: "custom_message" }, { type: "label" }])).toBe("here")
  })

  test("is tmux once the user has sent a message", () => {
    expect(defaultTarget([{ type: "message", message: { role: "user" } }])).toBe("tmux")
  })

  test("is tmux when an assistant message exists", () => {
    expect(defaultTarget([{ type: "message", message: { role: "assistant" } }])).toBe("tmux")
  })
})
