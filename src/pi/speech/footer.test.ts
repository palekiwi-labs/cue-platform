import { describe, expect, test } from "bun:test"
import { speechMarker } from "./footer"

describe("speech footer marker", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => `*${text}*` }

  test("is bold and coloured while live", () => {
    expect(speechMarker("speech: live", theme)).toBe("*<warning>speech: live*")
  })

  test("is empty while speech is off", () => {
    expect(speechMarker(undefined, theme)).toBe("")
    expect(speechMarker("", theme)).toBe("")
    expect(speechMarker("speech: off", theme)).toBe("")
    expect(speechMarker("speech: message", theme)).toBe("")
    expect(speechMarker("speech: shout", theme)).toBe("")
  })
})
