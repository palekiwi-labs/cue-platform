import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_STYLE,
  listStyles,
  registerResponseStyle,
  setActiveStyle,
  styleInstruction,
  withResponseStyle,
} from "./response-style"

type Handler = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>

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
  const pi = { on: (_name: string, h: Handler) => (handler = h) } as unknown as ExtensionAPI
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

  test("is empty for the default and for missing files", () => {
    expect(styleInstruction("default", dir)).toBe("")
    expect(styleInstruction("gone", dir)).toBe("")
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
