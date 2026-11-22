import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS } from "./context-usage"
import { configPath, defaultThresholds, loadConfig, parseConfig, registerConfig } from "./config"
import { thresholdsOf } from "./session-thresholds"

describe("configPath", () => {
  test("uses XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/cue-platform/cue-platform.json")
    expect(configPath({})).toEndWith("/.config/cue-platform/cue-platform.json")
  })
})

describe("parseConfig", () => {
  test("reads context.thresholds", () => {
    const { config, warnings } = parseConfig(
      JSON.stringify({ context: { thresholds: { caution: 90_000, soft: 120_000, hard: 160_000 } } }),
    )
    expect(config.context.thresholds).toEqual({ caution: 90_000, soft: 120_000, hard: 160_000 })
    expect(warnings).toEqual([])
  })

  test("missing values fall back field by field", () => {
    const { config, warnings } = parseConfig(JSON.stringify({ context: { thresholds: { soft: 110_000 } } }))
    expect(config.context.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, soft: 110_000 })
    expect(warnings).toEqual([])
  })

  test("an empty object is the built-in config", () => {
    expect(parseConfig("{}")).toEqual({ config: { context: { thresholds: DEFAULT_THRESHOLDS } }, warnings: [] })
  })

  test("invalid values warn and keep the built-in value", () => {
    const { config, warnings } = parseConfig(JSON.stringify({ context: { thresholds: { caution: "x" } } }))
    expect(config.context.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(warnings[0]).toContain("context.thresholds.caution")
  })

  test("out-of-order thresholds warn and use the built-in defaults", () => {
    const { config, warnings } = parseConfig(JSON.stringify({ context: { thresholds: { caution: 150_000 } } }))
    expect(config.context.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(warnings[0]).toContain("caution must be below soft")
  })

  test("invalid JSON and wrong shapes warn", () => {
    expect(parseConfig("{").warnings[0]).toContain("invalid JSON")
    expect(parseConfig("[]").warnings[0]).toContain("top level")
    expect(parseConfig('{"context": 1}').warnings[0]).toContain("context must be")
  })
})

describe("loadConfig and registerConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "cue-platform-config-"))
  const file = join(dir, "cue-platform.json")

  test("a missing file is the built-in config without warnings", () => {
    expect(loadConfig(join(dir, "absent.json")).warnings).toEqual([])
  })

  test("session start reloads the file and notifies on problems", () => {
    const handlers: ((e: unknown, c: unknown) => void)[] = []
    const pi = { on: (_e: string, fn: (e: unknown, c: unknown) => void) => handlers.push(fn) } as unknown as ExtensionAPI
    const notes: string[] = []
    const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } }

    writeFileSync(file, JSON.stringify({ context: { thresholds: { caution: 90_000, soft: 120_000, hard: 160_000 } } }))
    registerConfig(pi, () => file)
    expect(defaultThresholds().caution).toBe(90_000)
    expect(thresholdsOf({ sessionManager: { getBranch: () => [] } }).soft).toBe(120_000)

    writeFileSync(file, "{")
    handlers[0]!({ reason: "reload" }, ctx)
    expect(defaultThresholds()).toEqual(DEFAULT_THRESHOLDS)
    expect(notes[0]).toContain("invalid JSON")

    writeFileSync(file, "{}")
    handlers[0]!({ reason: "reload" }, ctx)
    expect(notes.length).toBe(1)
  })
})
