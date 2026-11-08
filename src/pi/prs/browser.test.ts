import { describe, expect, test } from "bun:test"
import { initTheme, type KeybindingsManager as AgentKeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui"
import { commentLines, PrBrowser, type PrDeps } from "./browser"
import type { Pr } from "./model"
import { parseDetail, PreviewCache, type PrDetail } from "./preview"

initTheme("dark", false)

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }
const pr = (number: number): Pr => ({
  repo: "o/r", number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`,
  author: "author", isDraft: false, createdAt: `2026-01-0${number}T00:00:00Z`,
  reviewDecision: null, checks: null, baseRef: "main", headRef: `branch-${number}`,
  defaultBranch: "main", reviewers: [], labels: [],
})
const detail = (body: string): PrDetail => ({
  threads: [{ kind: "comment", messages: [{ id: 1, author: "reviewer", body, at: "2026-01-01T00:00:00Z" }] }],
})
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()

class Browser extends PrBrowser {
  scroll(): number { return this.previewScroll }
  hints(): string[] { return this.helpHints() }
}

function setup(
  loadDetail: (pr: Pr) => Promise<PrDetail> = async () => detail("Comment body"),
  kb = new KeybindingsManager(TUI_KEYBINDINGS),
) {
  let renders = 0
  let loads = 0
  let closed = false
  const calls: number[] = []
  const terminal = { rows: 30 }
  const tui = { requestRender: () => { renders++ }, terminal } as unknown as TUI
  const deps = {
    view: "repo", orgs: ["o"], localRepo: "o/r", target: "here", previews: new PreviewCache(),
    load: async () => { loads++; return { prs: [pr(2), pr(1)], viewer: "author", failed: [], truncated: false } },
    links: async () => new Map(),
    detail: (p: Pr) => { calls.push(p.number); return loadDetail(p) },
  } as unknown as PrDeps
  const browser = new Browser(tui, theme, kb as AgentKeybindingsManager, deps, () => { closed = true })
  return { browser, calls, terminal, renders: () => renders, loads: () => loads, closed: () => closed }
}

describe("comment rendering", () => {
  test("shows compact thread context once, relative authors, spacing and thin separators", () => {
    const c = (id: number, body: string, at: string) => ({
      id, body, user: { login: `author${id}` }, created_at: at,
      path: "src/file.ts", line: 12, diff_hunk: "RAW DIFF HUNK", html_url: "https://github.com/raw-id",
    })
    const parsed = parseDetail(JSON.stringify([[
      c(1001, "Unique root", "2026-01-01T00:00:00Z"),
      { ...c(1002, "Unique reply", "2026-01-02T00:00:00Z"), in_reply_to_id: 1001 },
    ]]), JSON.stringify([[{ ...c(1003, "Review body", ""), submitted_at: "2026-01-01T12:00:00Z" }]]),
    JSON.stringify([[c(1004, "General body", "2026-01-01T06:00:00Z")]]))
    const lines = commentLines(parsed, 80, theme, Date.parse("2026-01-02T01:00:00Z")).map(plain)
    const text = lines.join("\n")
    expect(text.match(/Unique root/g)).toHaveLength(1)
    expect(text.match(/src\/file.ts:12/g)).toHaveLength(1)
    expect(text.match(/Review summary/g)).toHaveLength(1)
    expect(text.match(/Conversation/g)).toHaveLength(1)
    expect(text).toContain("@author1002 · 1h ago")
    expect(text).toContain("Unique root\n\n@author1002")
    expect(lines.filter((l) => l === "─".repeat(80))).toHaveLength(2)
    expect(text.indexOf("Unique root")).toBeLessThan(text.indexOf("Unique reply"))
    expect(text.indexOf("Unique reply")).toBeLessThan(text.indexOf("Review body"))
    expect(text.indexOf("Review body")).toBeLessThan(text.indexOf("General body"))
    expect(text).not.toMatch(/RAW DIFF HUNK|https:|reply to|thread root|2026-01/)
  })

  test("wraps Markdown prose, lists, code, long tokens and wide characters without dropping content", () => {
    const token = "abcdefghijklmnopqrstuvwxyz".repeat(4)
    const prose = "First **bold** words followed by enough prose to span several narrow pane lines END_PROSE"
    const body = `${prose}\n\n- list with *emphasis* and many words END_LIST\n\n\`\`\`ts\n${token}\n\`\`\`\n\n${token}\n\n界面文字`
    for (const width of [12, 24, 80]) {
      const lines = commentLines(detail(body), width, theme).map(plain)
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
      const compact = lines.join("").replace(/\s/g, "")
      expect(compact).toContain(prose.replace(/\*|\s/g, ""))
      expect(compact).toContain("END_LIST")
      expect(compact.split(token)).toHaveLength(3)
      expect(compact).toContain("界面文字")
    }
    expect(commentLines(detail(body), 24, theme).length).toBeGreaterThan(commentLines(detail(body), 80, theme).length)
  })

  test("keeps message Markdown isolated and has a comments-only empty state", () => {
    const d = detail("```ts\nunclosed fence")
    d.threads[0]!.messages.push({ id: 2, author: "next", body: "**Separate reply**", at: "2026-01-02T00:00:00Z" })
    const text = plain(commentLines(d, 80, theme).join("\n"))
    expect(text).toContain("Separate reply")
    expect(text).not.toContain("**Separate reply**")
    expect(commentLines({ threads: [] }, 80, theme)).toEqual(["No comments yet"])
  })
})

describe("PR browser preview", () => {
  test("lazy selected-only loading, stacked at narrow and wide widths, toggle and cache", async () => {
    const s = setup(async () => ({ ...detail("Comment body"), body: "PR_DESCRIPTION_ONLY" }))
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
      const preview = plain(lines.slice(separator + 1).join("\n"))
      expect(preview).toContain("COMMENTS / newest first")
      expect(preview).toContain("Comment body")
      for (const removed of ["PR 2", "PR_DESCRIPTION_ONLY", "Description", "o/r", "branch-2", "main", "Review:", "Checks:", "https://"]) {
        expect(preview).not.toContain(removed)
      }
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
    const kb = new KeybindingsManager(TUI_KEYBINDINGS)
    expect(kb.getKeys("tui.altScreen.halfPageDown")).toEqual([])
    expect(kb.getKeys("tui.altScreen.halfPageUp")).toEqual([])
    expect(kb.matches("\x04", "tui.altScreen.halfPageDown")).toBe(false)
    expect(kb.matches("\x1b[1;5F", "tui.altScreen.bottom")).toBe(true)
    const s = setup(async () => detail(Array.from({ length: 100 }, (_, i) => `paragraph ${i}\n`).join("\n")), kb)
    expect(s.browser.hints()).toEqual(expect.arrayContaining([
      "shift+up scroll up", "shift+down scroll down", "ctrl+home top", "ctrl+end bottom", "alt+l layout",
    ]))
    expect(kb.getUserBindings()).toEqual({})
    await tick()
    s.browser.render(80)
    await tick()
    s.browser.render(80)
    for (const key of ["\x04", "\x15"]) {
      s.browser.handleInput(key)
      expect(s.browser.scroll()).toBe(0)
    }
    s.browser.handleInput("\x1b[1;2B")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(7)
    s.browser.handleInput("\x1b[1;2A")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    s.browser.handleInput("\x1b[1;5F")
    s.browser.render(80)
    expect(s.browser.scroll()).toBeGreaterThan(100)
    s.browser.handleInput("\x1b[1;5H")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    s.browser.handleInput("\x1b[1;2B")
    s.browser.handleInput("\x1b[B")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(0)
    await tick()
    s.terminal.rows = 12
    expect(s.browser.render(24)).toHaveLength(12)
  })

  test("preview navigation and hints honor remapped and disabled actions", async () => {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.halfPageUp": "alt+u",
      "tui.altScreen.halfPageDown": ["alt+d", "alt+j"],
      "tui.altScreen.top": "alt+home",
      "tui.altScreen.bottom": "alt+end",
    })
    const s = setup(async () => detail("paragraph\n\n".repeat(100)), kb)
    await tick()
    s.browser.render(80)
    await tick()
    s.browser.render(80)
    for (const key of ["\x04", "\x15", "\x1b[1;2A", "\x1b[1;2B", "\x1b[1;5H", "\x1b[1;5F"]) {
      s.browser.handleInput(key)
      expect(s.browser.scroll()).toBe(0)
    }
    s.browser.handleInput("\x1bd")
    expect(s.browser.scroll()).toBe(7)
    s.browser.handleInput("\x1bj")
    expect(s.browser.scroll()).toBe(14)
    s.browser.handleInput("\x1bu")
    expect(s.browser.scroll()).toBe(7)
    s.browser.handleInput("\x1b[1;3F")
    s.browser.render(80)
    expect(s.browser.scroll()).toBeGreaterThan(100)
    s.browser.handleInput("\x1b[1;3H")
    expect(s.browser.scroll()).toBe(0)
    expect(s.browser.hints()).toEqual(expect.arrayContaining([
      "alt+u scroll up", "alt+d/alt+j scroll down", "alt+home top", "alt+end bottom",
    ]))
    expect(s.browser.hints().join(" ")).not.toContain("shift+down")
    expect(s.browser.hints().join(" ")).not.toContain("ctrl+home")

    const disabled = setup(undefined, new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.halfPageUp": [], "tui.altScreen.halfPageDown": [],
      "tui.altScreen.top": [], "tui.altScreen.bottom": [],
    }))
    for (const key of ["\x04", "\x15", "\x1b[1;2A", "\x1b[1;2B", "\x1b[1;5H", "\x1b[1;5F"]) {
      disabled.browser.handleInput(key)
      expect(disabled.browser.scroll()).toBe(0)
    }
    expect(disabled.browser.hints().join(" ")).not.toMatch(/scroll|top|bottom/)
  })

  test("layout toggle rewraps, clamps, resizes and preserves cached selection", async () => {
    const d = detail("A long paragraph with wide characters 界面 and readable wrapped Markdown.\n\n".repeat(100))
    const s = setup(async () => d)
    await tick()
    s.browser.render(80)
    await tick()
    s.browser.render(80)
    s.browser.handleInput("\x1b[1;5F")
    s.browser.render(80)
    const stackedBottom = s.browser.scroll()
    s.browser.handleInput("\x1bl")
    let lines = s.browser.render(80)
    expect(lines.slice(4, 29).every((line) => line.includes(" │ "))).toBe(true)
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true)
    expect(s.browser.scroll()).toBe(stackedBottom)
    s.browser.handleInput("\x1b[1;5H")
    s.browser.render(80)
    s.browser.handleInput("\x1b[1;2B")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(12)
    s.browser.handleInput("\x1b[1;5F")
    s.browser.render(80)
    const sideWidth = 80 - Math.floor(80 * 0.55) - 3
    expect(s.browser.scroll()).toBe(commentLines(d, sideWidth, theme).length - 25)
    s.browser.handleInput("\x1bl")
    s.browser.render(80)
    expect(s.browser.scroll()).toBe(stackedBottom)
    s.browser.handleInput("\x1bl")
    s.browser.render(80)
    for (const width of [24, 5, 4, 180]) {
      s.terminal.rows = 18
      lines = s.browser.render(width)
      expect(lines).toHaveLength(18)
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    }
    s.browser.handleInput("\x1b[1;5F")
    s.browser.render(180)
    s.terminal.rows = 3000
    s.browser.render(180)
    expect(s.browser.scroll()).toBe(0)
    s.browser.handleInput("\x1bp")
    expect(s.browser.render(80).join("\n")).not.toContain(" │ ")
    expect(s.browser.hints().join(" ")).not.toContain("scroll")
    s.browser.handleInput("\x1bl")
    s.browser.handleInput("\x1bp")
    s.terminal.rows = 30
    expect(s.browser.render(80)[13]).toBe("─".repeat(80))
    expect(s.calls).toEqual([2])
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
