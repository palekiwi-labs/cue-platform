import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui"
import { CueBrowser, type BrowserDeps, type BrowserStart } from "./browser"
import { parseContextTree } from "./model"

async function setup(view: BrowserStart["view"] = "contexts", days = 30) {
  const saved: number[] = []
  const resumed: string[] = []
  const artifactsOf: string[] = []
  const contexts = parseContextTree(JSON.stringify({ roots: [
    { context: "fresh", scope: "o/r", last_logged_at: Math.floor(Date.now() / 1000), children: [] },
    { context: "old-context", scope: "o/r", children: [] },
  ] }))
  const deps = {
    recencyDays: () => days,
    saveRecencyDays: (d: number) => saved.push(d),
    loadContexts: async () => contexts,
    sessionAddress: () => undefined,
    loadActivity: async () => [{
      id: "old", timestamp: 0, kind: "artifact_created", host: null, harness: null,
      sessionId: null, details: { address: "old-activity" },
    }],
    loadLog: async () => [{ title: "old-log", timestamp: 0 }],
    loadSessions: async () => [{ path: "/missing", cwd: "/w", address: "o/r/old-context", description: "old-session", modified: 0, tokens: null }],
    currentSession: () => undefined,
    currentCwd: () => ({ cwd: "/w" }),
    resume: (s: { path: string }) => { resumed.push(s.path); return undefined },
    loadArtifacts: async (address: string) => { artifactsOf.push(address); return [] },
  } as unknown as BrowserDeps
  const tui = { requestRender() {}, terminal: { rows: 30, columns: 160 } } as unknown as TUI
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager
  const start = view === "contexts" || view === "sessions"
    ? { view }
    : { view, context: { address: "o/r/fresh", slug: "fresh" } }
  const browser = new CueBrowser(tui, theme, kb, deps, () => {}, start, "here")
  browser.handleInput("\x1bp")
  await new Promise(resolve => setTimeout(resolve, 0))
  return { browser, saved, resumed, artifactsOf, text: () => browser.render(160).join("\n") }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe("CueBrowser alt+a artifacts", () => {
  test("sessions: opens the highlighted session's context, esc returns", async () => {
    const s = await setup("sessions", 0)
    s.browser.handleInput("\x1ba")
    await tick()
    expect(s.artifactsOf).toEqual(["o/r/old-context"])
    s.browser.handleInput("\x1b")
    expect(s.text()).toContain("old-session")
  })

  test("activity: artifacts replace activity, esc goes past both", async () => {
    const s = await setup("contexts", 0)
    s.browser.handleInput("\x01")
    await tick()
    s.browser.handleInput("\x1ba")
    await tick()
    expect(s.artifactsOf).toEqual(["o/r/fresh"])
    s.browser.handleInput("\x1b")
    expect(s.text()).toContain("old-context")
  })

  test("contexts: alt+a opens artifacts, enter resumes the newest session", async () => {
    const s = await setup("contexts", 0)
    s.browser.handleInput("\x1ba")
    await tick()
    expect(s.artifactsOf).toEqual(["o/r/fresh"])
    s.browser.handleInput("\x1b")
    s.browser.handleInput("\r")
    await tick()
    expect(s.resumed).toEqual([])
    expect(s.text()).toContain("no sessions in fresh; ctrl+s for a new one")
    s.browser.handleInput("\x1b[B")
    s.browser.handleInput("\r")
    await tick()
    expect(s.resumed).toEqual(["/missing"])
  })
})

describe("CueBrowser recency", () => {
  for (const view of ["contexts", "activity", "log", "sessions"] as const) {
    test(`${view}: all-time follows 30d and wraps both ways`, async () => {
      const s = await setup(view)
      expect(s.text()).toContain("recent 30d")
      s.browser.handleInput("\x1b[1;5A")
      expect(s.text()).toContain("all-time")
      expect(s.text()).not.toContain("0d")
      expect(s.text()).not.toContain("recent/all")
      s.browser.handleInput("\x1b[1;5A")
      expect(s.text()).toContain("recent 1d")
      s.browser.handleInput("\x1b[1;5B")
      expect(s.text()).toContain("all-time")
      s.browser.handleInput("\x1b[1;5B")
      expect(s.text()).toContain("recent 30d")
      expect(s.saved).toEqual([0, 1, 0, 30])
    })
  }

  for (const [view, old] of [["contexts", "old-context"], ["activity", "old-activity"], ["log", "old-log"], ["sessions", "old-session"]] as const) {
    test(`${view}: stored all-time shows old rows, narrowing hides them`, async () => {
      const s = await setup(view, 0)
      expect(s.text()).toContain("all-time")
      expect(s.text()).toContain(old)
      s.browser.handleInput("\x1b[1;5A")
      expect(s.text()).not.toContain(old)
    })
  }

  test("tab no longer changes the context window", async () => {
    const s = await setup()
    s.browser.handleInput("\t")
    expect(s.text()).toContain("recent 30d")
    expect(s.text()).not.toContain("old-context")
    expect(s.saved).toEqual([])
  })

  test("sessions tab still selects labeled, without a separate all subset", async () => {
    const s = await setup("sessions", 0)
    s.browser.handleInput("\t")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(s.text()).toContain("(labeled)")
    s.browser.handleInput("\t")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(s.text()).toContain("(all-time)")
  })
})
