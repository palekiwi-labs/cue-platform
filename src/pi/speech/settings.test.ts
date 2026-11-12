import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSpeechMode, speechMode } from "./settings"

const stateFile = () => join(mkdtempSync(join(tmpdir(), "speech-")), "speech.json")

describe("speech mode setting", () => {
  test("is off by default and persists each mode as a string", () => {
    const file = stateFile()
    expect(speechMode(file)).toBe("off")
    setSpeechMode("live", file)
    expect(speechMode(file)).toBe("live")
    setSpeechMode("message", file)
    expect(speechMode(file)).toBe("message")
    setSpeechMode("off", file)
    expect(speechMode(file)).toBe("off")
  })

  test("reads an unknown stored value as off", () => {
    const file = stateFile()
    writeFileSync(file, JSON.stringify({ mode: "shout" }))
    expect(speechMode(file)).toBe("off")
  })
})
