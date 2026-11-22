import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerConfig } from "./config"
import { contextMode, parseContextMode } from "./context-mode"
import { CUE_CONTEXT_TYPE } from "./current-context"
import { resolveThresholds, storedThresholds } from "./session-thresholds"

describe("parseContextMode", () => {
  test("reads mode from frontmatter only", () => {
    expect(parseContextMode("---\ntitle: x\nmode: build\n---\nbody")).toBe("build")
    expect(parseContextMode("---\nmode: 'review'\n---\n")).toBe("review")
    expect(parseContextMode("---\nkind: coord\n---\nmode: build")).toBeUndefined()
    expect(parseContextMode("mode: build")).toBeUndefined()
  })
})

describe("contextMode and resolveThresholds", () => {
  const root = mkdtempSync(join(tmpdir(), "cue-store-"))
  const write = (address: string, fm: string) => {
    mkdirSync(join(root, address), { recursive: true })
    writeFileSync(join(root, address, "context.md"), `---\n${fm}\n---\n`)
  }

  test("reads and re-reads context.md", () => {
    write("o/r/a", "mode: build")
    expect(contextMode("o/r/a", root)).toBe("build")
    expect(contextMode("o/r/missing", root)).toBeUndefined()
  })

  test("the linked context's mode selects the defaults; a session entry wins", () => {
    const prev = process.env.CUE_STORE
    process.env.CUE_STORE = root
    write("o/r/b", "mode: build")
    write("o/r/c", "kind: coord")
    const file = join(root, "cfg.json")
    writeFileSync(file, JSON.stringify({ context: { modes: { build: { thresholds: { hard: 170_000 } } } } }))
    registerConfig({ on: () => {} } as unknown as ExtensionAPI, () => file)
    const link = (address: string) => ({ type: "custom", customType: CUE_CONTEXT_TYPE, data: { address } })
    const ctx = (branch: unknown[]) => ({ sessionManager: { getBranch: () => branch as never } })
    try {
      expect(resolveThresholds(ctx([link("o/r/b")])).source).toEqual({ kind: "mode", mode: "build" })
      expect(resolveThresholds(ctx([link("o/r/b")])).thresholds.hard).toBe(170_000)
      expect(resolveThresholds(ctx([link("o/r/c")])).source).toEqual({ kind: "built-in" })
      const own = { type: "custom", customType: "cue-thresholds", data: { caution: 1, soft: 2, hard: 3 } }
      const r = resolveThresholds(ctx([link("o/r/b"), own]))
      expect(r.source).toEqual({ kind: "session" })
      expect(r.defaults.hard).toBe(170_000)
      expect(storedThresholds(undefined, "o/r/b").hard).toBe(170_000)
      expect(storedThresholds(undefined, undefined).hard).toBe(140_000)
      expect(storedThresholds({ caution: 1, soft: 2, hard: 3 }, "o/r/b").hard).toBe(3)
    } finally {
      if (prev === undefined) delete process.env.CUE_STORE
      else process.env.CUE_STORE = prev
      writeFileSync(file, "{}")
      registerConfig({ on: () => {} } as unknown as ExtensionAPI, () => file)
    }
  })
})
