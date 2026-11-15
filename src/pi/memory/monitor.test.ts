import { expect, test } from "bun:test"
import type { KeybindingsManager as AgentKeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui"
import { MemoryMonitor } from "./monitor"
import type { MemorySource } from "./model"

const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme
const kb = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AgentKeybindingsManager
const source: MemorySource = {
  root: "memory",
  levels: async () => [],
  runs: async () => [],
  commits: async () => [],
  show: async () => undefined,
}

test("memory preview uses shifted arrows without changing selection", async () => {
  const monitor = new MemoryMonitor(tui, theme, kb, source, "here", () => {})
  const state = monitor as unknown as { scroll: number; selected: Record<string, string | undefined> }
  try {
    await Promise.resolve()
    const selected = { ...state.selected }
    monitor.handleInput("\x1b[1;2B")
    expect(state.scroll).toBe(12)
    for (const key of ["\x04", "\x15"]) {
      monitor.handleInput(key)
      expect(state.scroll).toBe(12)
    }
    expect(state.selected).toEqual(selected)
    monitor.handleInput("\x1b[1;2A")
    expect(state.scroll).toBe(0)
    monitor.handleInput("\x1b[1;2A")
    expect(state.scroll).toBe(0)
    for (const key of ["\x04", "\x15"]) {
      monitor.handleInput(key)
      expect(state.scroll).toBe(0)
    }
    const help = monitor.render(160)[1]!
    expect(help).toContain("shift+up/down scroll")
    expect(help).not.toContain("ctrl+d/u")
  } finally {
    monitor.close()
  }
})
