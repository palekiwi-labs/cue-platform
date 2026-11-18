import { describe, expect, test } from "bun:test"
import { speechActive } from "./footer"

describe("speech footer state", () => {
  test("is active while live", () => {
    expect(speechActive("speech: live")).toBe(true)
  })

  test("is inactive while speech is off or unknown", () => {
    expect(speechActive(undefined)).toBe(false)
    expect(speechActive("")).toBe(false)
    expect(speechActive("speech: off")).toBe(false)
    expect(speechActive("speech: message")).toBe(false)
  })
})
