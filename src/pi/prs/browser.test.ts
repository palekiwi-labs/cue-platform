import { describe, expect, test } from "bun:test"
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui"
import { PrBrowser, type PrDeps } from "./browser"
import type { Pr } from "./model"
import { PreviewCache, type PrDetail } from "./preview"

initTheme("dark", false)

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }
const pr = (number: number): Pr => ({
  repo: "o/r", number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`,
  author: "author", isDraft: false, createdAt: `2026-01-0${number}T00:00:00Z`,
  reviewDecision: null, checks: null, baseRef: "main", headRef: `branch-${number}`,
  defaultBranch: "main", reviewers: [], labels: [],
})
const detail = (body: string): PrDetail => ({ body, feedback: [] })

class Browser extends PrBrowser {
  scroll(): number { return this.previewScroll }
}

function setup(loadDetail: (pr: Pr) => Promise<PrDetail> = async () => detail("Description")) {
  let renders = 0
  let loads = 0
  let closed = false
  const calls: number[] = []
  const terminal = { rows: 30 }
  const tui = { requestRender: () => { renders++ }, terminal } as unknown as TUI
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
  const keys: Record<string, string> = {
    "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown",
  }
  const kb = { matches: (d: string, id: string) => keys[id] ? matchesKey(d, keys[id] as Parameters<typeof matchesKey>[1]) : false } as unknown as KeybindingsManager
  const deps = {
    view: "repo", orgs: ["o"], localRepo: "o/r", target: "here", previews: new PreviewCache(),
    load: async () => { loads++; return { prs: [pr(2), pr(1)], viewer: "author", failed: [], truncated: false } },
    links: async () => new Map(),
    detail: (p: Pr) => { calls.push(p.number); return loadDetail(p) },
  } as unknown as PrDeps
  const browser = new Browser(tui, theme, kb, deps, () => { closed = true })
  return { browser, calls, terminal, renders: () => renders, loads: () => loads, closed: () => closed }
}

describe("PR browser preview", () => {
  test("lazy selected-only loading, stacked at narrow and wide widths, toggle and cache", async () => {
    const s = setup()
    await tick()
    expect(s.calls).toEqual([])
    expect(s.browser.render(80).join("\n")).toContain("Loading o/r#2")
    await tick()
    expect(s.calls).toEqual([2])
    for (const width of [24, 80, 180]) {
      const lines = s.browser.render(width)
      expect(lines).toHaveLength(30)
      expect(lines.every((l) => visibleWidth(l) <= width)).toBe(true)
      const separator = lines.findIndex((l, i) => i > 4 && l === "─".repeat(width))
      expect(separator).toBe(13)
      expect(lines.slice(separator + 1).join("\n")).toContain("PR 2")
    }
    s.browser.handleInput("\x1bp")
    s.browser.handleInput("\x1b[B")
    s.browser.render(80)
    await tick()
    expect(s.calls).toEqual([2])
    s.browser.handleInput("\x1bp")
    s.browser.render(80)
    await tick()
    expect(s.calls).toEqual([2, 1])
    s.browser.handleInput("\x1b[A")
    s.browser.render(80)
    await tick()
    expect(s.calls).toEqual([2, 1])
  })

  test("half-page scrolling, top/bottom clamping, resize and selection reset", async () => {
    const s = setup(async () => detail(Array.from({ length: 100 }, (_, i) => `paragraph ${i}\n`).join("\n")))
    await tick()
    s.browser.render(80)
    await tick()
    s.browser.render(80)
    s.browser.handleInput("\x04")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(7)
    s.browser.handleInput("\x15")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    s.browser.handleInput("\x1b[1;5F")
    s.browser.render(80)
    expect(s.browser.scroll()).toBeGreaterThan(100)
    s.browser.handleInput("\x1b[1;5H")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    s.browser.handleInput("\x04")
    s.browser.handleInput("\x1b[B")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    await tick()
    s.terminal.rows = 12
    expect(s.browser.render(24)).toHaveLength(12)
  })

  test("late result from another selection never appears in the active preview", async () => {
    let resolve!: (value: PrDetail) => void
    const pending = new Promise<PrDetail>((yes) => { resolve = yes })
    const s = setup((p) => p.number === 2 ? pending : Promise.resolve(detail("CURRENT ONLY")))
    await tick()
    s.browser.render(80)
    s.browser.handleInput("\x1b[B")
    s.browser.render(80)
    await tick()
    resolve(detail("STALE ONLY"))
    await tick()
    const rendered = s.browser.render(80).join("\n")
    expect(rendered).not.toContain("STALE ONLY")
    s.browser.handleInput("\x1b[1;5F")
    expect(s.browser.render(80).join("\n")).toContain("CURRENT ONLY")
  })

  test("refresh retries errors and invalidates preview; close suppresses async render", async () => {
    let fail = true
    const s = setup(async () => { if (fail) throw new Error("forbidden"); return detail("Recovered") })
    await tick()
    s.browser.render(80)
    await tick()
    expect(s.browser.render(80).join("\n")).toContain("forbidden")
    fail = false
    s.browser.handleInput("\x1br")
    s.browser.render(80)
    await tick()
    expect(s.loads()).toBe(2)
    expect(s.calls).toEqual([2, 2])
    expect(s.browser.render(80).join("\n")).not.toContain("forbidden")
    let resolve!: (value: PrDetail) => void
    const pending = new Promise<PrDetail>((yes) => { resolve = yes })
    const closing = setup(() => pending)
    await tick()
    closing.browser.render(80)
    closing.browser.close()
    const before = closing.renders()
    resolve(detail("Late"))
    await tick()
    expect(closing.closed()).toBe(true)
    expect(closing.renders()).toBe(before)
  })

  test("repo heading and empty search have no stale preview", async () => {
    const s = setup()
    await tick()
    s.browser.render(80)
    await tick()
    s.browser.handleInput("\x1bv")
    await tick()
    s.browser.render(80)
    s.browser.handleInput("\x1bz")
    expect(s.browser.render(80).join("\n")).toContain("Select a PR")
    s.browser.handleInput("no-match")
    expect(s.browser.render(80).join("\n")).toContain("Select a PR")
    expect(s.calls).toEqual([2])
  })
})
