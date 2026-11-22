import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS } from "./context-usage"
import { registerSessionThresholds, SessionThresholds, thresholdsError } from "./session-thresholds"

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

describe("SessionThresholds", () => {
  test("starts at the defaults", () => {
    const h = new SessionThresholds()
    expect(h.get()).toEqual(DEFAULT_THRESHOLDS)
    expect(h.adjusted()).toBe(false)
  })

  test("set applies valid values and keeps old ones on error", () => {
    const h = new SessionThresholds()
    expect(h.set({ caution: 90_000, soft: 120_000, hard: 160_000 }, 200_000)).toBeNull()
    expect(h.get()).toEqual({ caution: 90_000, soft: 120_000, hard: 160_000 })
    expect(h.adjusted()).toBe(true)
    expect(h.set({ caution: 1, soft: 2, hard: 300_000 }, 200_000)).not.toBeNull()
    expect(h.get().hard).toBe(160_000)
  })

  test("get returns a copy", () => {
    const h = new SessionThresholds()
    h.get().caution = 1
    expect(h.get()).toEqual(DEFAULT_THRESHOLDS)
  })

  test("resets on session_start", () => {
    const handlers: Record<string, () => void> = {}
    const pi = { on: (event: string, fn: () => void) => { handlers[event] = fn } } as unknown as ExtensionAPI
    const h = registerSessionThresholds(pi)
    h.set({ caution: 10, soft: 20, hard: 30 })
    handlers.session_start!()
    expect(h.get()).toEqual(DEFAULT_THRESHOLDS)
  })
})
