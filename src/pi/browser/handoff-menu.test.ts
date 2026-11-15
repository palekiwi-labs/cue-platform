import { describe, expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui"
import { type BrowserDeps, CueBrowser, type Target } from "./browser"
import { handoffChoices, HandoffMenu, type HandoffPick, NONE_LABEL } from "./handoff-menu"
import { type ArtifactRow, parseContextTree } from "./model"

const C = "o/r/demo"
const theme = { fg: (_c: any, s: string) => s, bg: (_c: any, s: string) => s, bold: (s: string) => s }
const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const row = (type: string, name: string, createdAt: number | null): ArtifactRow => ({
  path: `/store/${C}/${type}/${name}`, name, type, title: name, status: null, priority: null, createdAt,
})

const rows = [
  row("trace", "handoff-old.md", 100),
  row("trace", "review.md", 500),
  row("note", "handoff-note.md", 400),
  row("trace", "handoff-new.md", 300),
  row("trace", "nested/handoff-deep.md", 200),
]

describe("handoffChoices", () => {
  test("hand-off traces of the context only, newest first", () => {
    const choices = handoffChoices(C, rows, 3600 + 300)
    expect(choices.map((c) => c.address)).toEqual([
      `${C}/trace/handoff-new.md`,
      `${C}/trace/nested/handoff-deep.md`,
      `${C}/trace/handoff-old.md`,
    ])
    expect(choices[0]!.age).toBe("1h")
  })
})

describe("HandoffMenu", () => {
  const open = () => {
    const picks: HandoffPick[] = []
    const menu = new HandoffMenu(theme, kb, "new session: demo", handoffChoices(C, rows, 1000), (p) => picks.push(p))
    return { menu, picks }
  }

  test("the newest hand-off is preselected", () => {
    const { menu, picks } = open()
    expect(menu.render(60).join("\n")).toContain("> handoff-new.md")
    menu.handleInput("\r")
    expect(picks).toEqual([{ handoff: `${C}/trace/handoff-new.md` }])
  })

  test("none is listed last and picks no hand-off", () => {
    const { menu, picks } = open()
    menu.handleInput(UP)
    expect(menu.render(60).join("\n")).toContain(`> ${NONE_LABEL}`)
    menu.handleInput("\r")
    expect(picks).toEqual([{}])
  })

  test("an older hand-off can be picked", () => {
    const { menu, picks } = open()
    menu.handleInput(DOWN)
    menu.handleInput(DOWN)
    menu.handleInput("\r")
    expect(picks).toEqual([{ handoff: `${C}/trace/handoff-old.md` }])
  })

  test("esc cancels", () => {
    const { menu, picks } = open()
    menu.handleInput("\x1b")
    expect(picks).toEqual([null])
  })

  test("long lists scroll to keep the selection visible", () => {
    const many = Array.from({ length: 15 }, (_, i) => row("trace", `handoff-${i}.md`, i))
    const menu = new HandoffMenu(theme, kb, "t", handoffChoices(C, many, 100), () => {})
    expect(menu.render(60).join("\n")).toContain("↓ 6 more")
    menu.handleInput(UP)
    const text = menu.render(60).join("\n")
    expect(text).toContain(`> ${NONE_LABEL}`)
    expect(text).toContain("↑ 6 more")
  })
})

describe("CueBrowser ctrl+s", () => {
  async function setup(artifacts: ArtifactRow[], target: Target = "here") {
    const started: { address: string; target: Target; handoff?: string }[] = []
    let overlay: Component | undefined
    let hidden = false
    const contexts = parseContextTree(JSON.stringify({ roots: [
      { context: "demo", scope: "o/r", last_logged_at: Math.floor(Date.now() / 1000), children: [] },
    ] }))
    const deps = {
      recencyDays: () => 30,
      saveRecencyDays: () => {},
      loadContexts: async () => contexts,
      sessionAddress: () => undefined,
      loadArtifacts: async () => artifacts,
      newSession: (address: string, t: Target, handoff?: string) => {
        started.push({ address, target: t, ...(handoff ? { handoff } : {}) })
        return undefined
      },
    } as unknown as BrowserDeps
    const tui = {
      requestRender() {},
      terminal: { rows: 30, columns: 120 },
      showOverlay: (c: Component) => {
        overlay = c
        return { hide: () => { hidden = true } }
      },
    } as unknown as TUI
    let closed = false
    const browser = new CueBrowser(tui, theme as unknown as Theme, kb, deps, () => { closed = true }, { view: "contexts" }, target)
    await tick()
    browser.handleInput("\x13")
    await tick()
    return {
      started,
      overlay: () => overlay,
      hidden: () => hidden,
      closed: () => closed,
    }
  }

  test("offers the context's hand-offs and starts from the newest by default", async () => {
    const s = await setup(rows)
    expect(s.overlay()).toBeDefined()
    expect(s.started).toEqual([])
    s.overlay()!.handleInput!("\r")
    expect(s.hidden()).toBe(true)
    expect(s.started).toEqual([{ address: C, target: "here", handoff: `${C}/trace/handoff-new.md` }])
    expect(s.closed()).toBe(true)
  })

  test("none starts without a hand-off, in tmux too", async () => {
    const s = await setup(rows, "tmux")
    s.overlay()!.handleInput!(UP)
    s.overlay()!.handleInput!("\r")
    expect(s.started).toEqual([{ address: C, target: "tmux" }])
    expect(s.closed()).toBe(false)
  })

  test("esc starts nothing", async () => {
    const s = await setup(rows)
    s.overlay()!.handleInput!("\x1b")
    expect(s.started).toEqual([])
    expect(s.closed()).toBe(false)
  })

  test("a context without hand-offs starts at once", async () => {
    const s = await setup([row("trace", "review.md", 1)])
    expect(s.overlay()).toBeUndefined()
    expect(s.started).toEqual([{ address: C, target: "here" }])
  })
})
