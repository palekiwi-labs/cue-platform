import { describe, expect, test } from "bun:test"
import {
  buildReport,
  contextNote,
  DEFAULT_THRESHOLDS,
  formatReport,
} from "./context-usage"

describe("buildReport", () => {
  test("nominal below caution", () => {
    const r = buildReport(79_999)
    expect(r.level).toBe("nominal")
    expect(r.canProceed).toEqual({ smallTask: true, largeTask: true })
  })

  test("caution at the caution limit", () => {
    expect(buildReport(80_000).level).toBe("caution")
  })

  test("exceeded_soft at the soft limit; small tasks only", () => {
    const r = buildReport(100_000)
    expect(r.level).toBe("exceeded_soft")
    expect(r.canProceed).toEqual({ smallTask: false, largeTask: false })
  })

  test("critical at the hard limit", () => {
    expect(buildReport(140_000).level).toBe("critical")
  })

  test("headroom never goes negative", () => {
    const r = buildReport(200_000)
    expect(r.headroom.soft).toBe(0)
    expect(r.headroom.hard).toBe(0)
  })
})

describe("formatReport", () => {
  test("renders the checkpoint block", () => {
    const text = formatReport(buildReport(50_000))
    expect(text).toContain("Context Saturation Checkpoint")
    expect(text).toContain("Tokens: 50,000")
    expect(text).toContain("Level: NOMINAL")
  })
})

describe("contextNote", () => {
  test("level name only, no numbers", () => {
    expect(contextNote("nominal")).toBe("Context: nominal.")
    expect(contextNote("critical")).not.toMatch(/\d/)
  })
})

test("default thresholds match the opencode decision model", () => {
  expect(DEFAULT_THRESHOLDS).toEqual({ caution: 80_000, soft: 100_000, hard: 140_000 })
})
