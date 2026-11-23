import { expect, test } from "bun:test"
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui"
import type { SessionRowsProgress } from "../lib/session-files"
import { CueBrowser, type BrowserDeps } from "./browser"
import { parseContextTree } from "./model"
import type { SessionRow } from "./sessions"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("sessions view renders partial rows while the load runs", async () => {
  const now = Math.floor(Date.now() / 1000)
  const contexts = parseContextTree(JSON.stringify({ roots: [{ context: "c", scope: "o/r", children: [] }] }))
  const row = (description: string): SessionRow =>
    ({ path: `/${description}`, cwd: "/w", address: "o/r/c", description, tokens: null, modified: now })
  let progress: SessionRowsProgress | undefined
  let finish: (rows: SessionRow[]) => void = () => {}
  let loads = 0
  const deps = {
    recencyDays: () => 30,
    loadContexts: async () => contexts,
    sessionAddress: () => undefined,
    loadSessions: (_: boolean, onProgress?: SessionRowsProgress) => {
      loads++
      progress = onProgress
      return new Promise<SessionRow[]>((resolve) => (finish = resolve))
    },
    currentSession: () => undefined,
    currentCwd: () => ({ cwd: "/w" }),
  } as unknown as BrowserDeps
  const tui = { requestRender() {}, terminal: { rows: 30, columns: 160 } } as unknown as TUI
  const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as unknown as Theme
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager
  const browser = new CueBrowser(tui, theme, kb, deps, () => {}, { view: "sessions" }, "here")
  browser.handleInput("\x1bp")
  const text = () => browser.render(160).join("\n")
  await tick()
  expect(text()).toContain("loading…")

  progress!(1, 20, [row("first-row")])
  expect(text()).toContain("first-row")
  expect(text()).toContain("loading 1/20")

  progress!(2, 20)
  expect(text()).toContain("loading 2/20")

  progress!(10, 20, [row("tenth-row"), row("first-row")])
  expect(text()).toContain("tenth-row")

  finish([row("last-row"), row("tenth-row"), row("first-row")])
  await tick()
  expect(text()).toContain("last-row")
  expect(text()).not.toContain("loading")
  expect(loads).toBe(1)
})
