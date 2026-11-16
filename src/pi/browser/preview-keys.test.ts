import { expect, test } from "bun:test"
import type { KeybindingsManager as AgentKeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui"
import { CueBrowser, type BrowserDeps } from "./browser"

const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI
const theme = {} as Theme
const kb = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AgentKeybindingsManager

test("cue preview uses shifted arrows without changing selection", async () => {
  const browser = new CueBrowser(tui, theme, kb, {
    recencyDays: () => undefined,
    loadArtifacts: async () => [],
  } as unknown as BrowserDeps, () => {}, {
    view: "artifacts", context: { address: "o/r/c", slug: "c" },
  }, "here")
  const state = browser as unknown as { previewScroll: number; view?: { selected: number } }
  await Promise.resolve()
  const selected = state.view?.selected
  browser.handleInput("\x1b[1;2B")
  expect(state.previewScroll).toBeGreaterThan(0)
  const scrolled = state.previewScroll
  for (const key of ["\x04", "\x15"]) {
    browser.handleInput(key)
    expect(state.previewScroll).toBe(scrolled)
  }
  expect(state.view?.selected).toBe(selected)
  browser.handleInput("\x1b[1;2A")
  expect(state.previewScroll).toBe(0)
  for (const key of ["\x04", "\x15"]) {
    browser.handleInput(key)
    expect(state.previewScroll).toBe(0)
  }
})
