import { describe, expect, test } from "bun:test"
import { DEFAULT_THRESHOLDS } from "./context-usage"
import {
  sessionThresholds,
  setSessionThresholds,
  thresholdsError,
  thresholdsOf,
  THRESHOLDS_TYPE,
} from "./session-thresholds"

describe("thresholdsError", () => {
  test("accepts the defaults with and without a window", () => {
    expect(thresholdsError(DEFAULT_THRESHOLDS)).toBeNull()
    expect(thresholdsError(DEFAULT_THRESHOLDS, 200_000)).toBeNull()
  })

  test("requires strictly increasing values", () => {
    expect(thresholdsError({ caution: 100_000, soft: 100_000, hard: 140_000 })).toMatch(/caution/)
    expect(thresholdsError({ caution: 80_000, soft: 150_000, hard: 140_000 })).toMatch(/soft/)
  })

  test("hard may equal but not exceed a known window", () => {
    expect(thresholdsError({ caution: 1, soft: 2, hard: 128_000 }, 128_000)).toBeNull()
    expect(thresholdsError(DEFAULT_THRESHOLDS, 128_000)).toMatch(/context window/)
  })

  test("rejects non-positive and fractional values", () => {
    expect(thresholdsError({ caution: 0, soft: 2, hard: 3 })).not.toBeNull()
    expect(thresholdsError({ caution: 1.5, soft: 2, hard: 3 })).not.toBeNull()
  })
})

describe("session thresholds in the transcript", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: THRESHOLDS_TYPE, data })

  test("defaults when the branch has no thresholds entry", () => {
    expect(sessionThresholds([])).toEqual(DEFAULT_THRESHOLDS)
    expect(thresholdsOf({})).toEqual(DEFAULT_THRESHOLDS)
  })

  test("the newest valid entry wins", () => {
    const branch = [
      entry({ caution: 90_000, soft: 120_000, hard: 160_000 }),
      { type: "message" },
      entry({ caution: 95_000, soft: 125_000, hard: 170_000 }),
      entry({ caution: 5, soft: 1, hard: 2 }),
    ]
    expect(sessionThresholds(branch)).toEqual({ caution: 95_000, soft: 125_000, hard: 170_000 })
  })

  test("ignores other custom types and custom messages", () => {
    const t = { caution: 90_000, soft: 120_000, hard: 160_000 }
    expect(sessionThresholds([{ type: "custom", customType: "cue-context", data: t }])).toEqual(DEFAULT_THRESHOLDS)
    expect(sessionThresholds([{ type: "custom_message", customType: THRESHOLDS_TYPE, data: t }])).toEqual(DEFAULT_THRESHOLDS)
  })

  test("setSessionThresholds appends valid values only", () => {
    const appended: [string, unknown][] = []
    const pi = { appendEntry: (type: string, data: unknown) => appended.push([type, data]) }
    expect(setSessionThresholds(pi, { caution: 90_000, soft: 120_000, hard: 160_000 }, 200_000)).toBeNull()
    expect(setSessionThresholds(pi, { caution: 1, soft: 2, hard: 300_000 }, 200_000)).not.toBeNull()
    expect(appended).toEqual([[THRESHOLDS_TYPE, { caution: 90_000, soft: 120_000, hard: 160_000 }]])
  })
})
