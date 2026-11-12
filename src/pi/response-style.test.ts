import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_STYLE,
  listStyles,
  parseStyle,
  registerResponseStyle,
  setActiveStyle,
  styleInstruction,
  switchStyle,
  withResponseStyle,
  withVerbosity,
} from "./response-style"

type Handler = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>

function fakePi() {
  const handlers: Record<string, (event: any, ctx?: any) => unknown> = {}
  let level = "high"
  const pi = {
    on: (name: string, h: (event: any, ctx?: any) => unknown) => (handlers[name] = h),
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => {
      const previousLevel = level
      level = next === "minimal" ? "low" : next
      handlers.thinking_level_select?.({ level, previousLevel })
    },
  } as unknown as ExtensionAPI
  registerResponseStyle(pi, dir)
  return { pi, handlers, level: () => level }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "styles-"))
  writeFileSync(join(dir, "terse.md"), "Be terse.\n")
  writeFileSync(join(dir, "gangsta.md"), "Talk gangsta.\n")
  writeFileSync(join(dir, "notes.txt"), "ignored")
})

afterEach(() => {
  setActiveStyle(DEFAULT_STYLE)
  rmSync(dir, { recursive: true, force: true })
})

function captureHandler(): Handler {
  let handler: Handler | undefined
  const pi = {
    on: (name: string, h: Handler) => {
      if (name === "before_agent_start") handler = h
    },
  } as unknown as ExtensionAPI
  registerResponseStyle(pi, dir)
  return handler!
}

describe("listStyles", () => {
  test("lists default first, then markdown files sorted", () => {
    expect(listStyles(dir)).toEqual(["default", "gangsta", "terse"])
  })

  test("falls back to default when the directory is missing", () => {
    expect(listStyles(join(dir, "missing"))).toEqual(["default"])
  })
})

describe("styleInstruction", () => {
  test("reads the trimmed file body", () => {
    expect(styleInstruction("terse", dir)).toBe("Be terse.")
  })

  test("is empty for missing files, including an absent default", () => {
    expect(styleInstruction("default", dir)).toBe("")
    expect(styleInstruction("gone", dir)).toBe("")
  })

  test("reads default.md when it exists", () => {
    writeFileSync(join(dir, "default.md"), "Questions last.")
    expect(styleInstruction("default", dir)).toBe("Questions last.")
    expect(listStyles(dir)).toEqual(["default", "gangsta", "terse"])
  })
})

describe("parseStyle", () => {
  test("splits frontmatter settings from the body", () => {
    expect(parseStyle("---\nverbosity: low\nthinking: \"minimal\"\n---\nTalk.\n")).toEqual({
      settings: { verbosity: "low", thinking: "minimal" },
      instruction: "Talk.",
    })
  })

  test("treats a file without frontmatter as all instruction", () => {
    expect(parseStyle("Be terse.\n")).toEqual({ settings: {}, instruction: "Be terse." })
  })
})

describe("withVerbosity", () => {
  test("sets text verbosity on OpenAI Responses payloads, keeping other text fields", () => {
    expect(withVerbosity({ model: "m", text: { format: "x" } }, "openai-responses", "low")).toEqual({
      model: "m",
      text: { format: "x", verbosity: "low" },
    })
  })

  test("leaves other APIs and styles without verbosity alone", () => {
    expect(withVerbosity({ model: "m" }, "anthropic-messages", "low")).toBeUndefined()
    expect(withVerbosity({ model: "m" }, "openai-responses", undefined)).toBeUndefined()
  })
})

describe("switchStyle", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "chat.md"), "---\nverbosity: low\nthinking: minimal\n---\nTalk.\n")
  })

  test("applies the style's thinking level and restores it on leaving", () => {
    const { pi, level } = fakePi()
    switchStyle(pi, "chat", dir)
    expect(level()).toBe("low")
    switchStyle(pi, "terse", dir)
    expect(level()).toBe("high")
  })

  test("keeps a level the operator set by hand while the style was active", () => {
    const { pi, level } = fakePi()
    switchStyle(pi, "chat", dir)
    pi.setThinkingLevel("medium")
    switchStyle(pi, DEFAULT_STYLE, dir)
    expect(level()).toBe("medium")
  })

  test("adds verbosity to requests while the style is active", async () => {
    const { pi, handlers } = fakePi()
    switchStyle(pi, "chat", dir)
    const ctx = { model: { api: "openai-responses" } }
    expect(await handlers.before_provider_request!({ payload: {} }, ctx)).toEqual({ text: { verbosity: "low" } })
    switchStyle(pi, DEFAULT_STYLE, dir)
    expect(await handlers.before_provider_request!({ payload: {} }, ctx)).toBeUndefined()
  })
})

describe("withResponseStyle", () => {
  test("leaves the prompt alone without an instruction", () => {
    expect(withResponseStyle("base", "default", "")).toBe("base")
  })

  test("appends a named style block", () => {
    expect(withResponseStyle("base", "terse", "Be terse.")).toBe(
      'base\n\n<response_style name="terse">\nBe terse.\n</response_style>',
    )
  })
})

describe("registerResponseStyle", () => {
  test("adds nothing under the default style", async () => {
    expect(await captureHandler()({ systemPrompt: "base" })).toBeUndefined()
  })

  test("follows a style change and file edits on the next turn", async () => {
    const handler = captureHandler()
    setActiveStyle("terse")
    expect((await handler({ systemPrompt: "base" }))?.systemPrompt).toContain("Be terse.")
    writeFileSync(join(dir, "terse.md"), "Be very terse.")
    expect((await handler({ systemPrompt: "base" }))?.systemPrompt).toContain("Be very terse.")
  })
})
