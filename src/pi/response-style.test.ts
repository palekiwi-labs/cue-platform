import { afterEach, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { activeStyle, registerResponseStyle, RESPONSE_STYLES, setActiveStyle, withResponseStyle } from "./response-style"

type Handler = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>

function captureHandler(): Handler {
  let handler: Handler | undefined
  const pi = { on: (_name: string, h: Handler) => (handler = h) } as unknown as ExtensionAPI
  registerResponseStyle(pi)
  return handler!
}

const gangsta = RESPONSE_STYLES.findIndex((s) => s.name === "gangsta")

afterEach(() => setActiveStyle(0))

describe("withResponseStyle", () => {
  test("leaves the prompt alone for the default style", () => {
    expect(withResponseStyle("base", RESPONSE_STYLES[0]!)).toBe("base")
  })

  test("appends a named style block", () => {
    const out = withResponseStyle("base", RESPONSE_STYLES[gangsta]!)
    expect(out.startsWith("base\n\n<response_style name=\"gangsta\">\n")).toBe(true)
    expect(out.endsWith("</response_style>")).toBe(true)
  })
})

describe("setActiveStyle", () => {
  test("ignores out-of-range indexes", () => {
    setActiveStyle(gangsta)
    setActiveStyle(99)
    setActiveStyle(-1)
    expect(activeStyle()).toBe(gangsta)
  })
})

describe("registerResponseStyle", () => {
  test("adds nothing under the default style", async () => {
    expect(await captureHandler()({ systemPrompt: "base" })).toBeUndefined()
  })

  test("follows a mid-session style change on the next turn", async () => {
    const handler = captureHandler()
    setActiveStyle(gangsta)
    const result = await handler({ systemPrompt: "base" })
    expect(result?.systemPrompt).toContain("<response_style name=\"gangsta\">")
  })
})
