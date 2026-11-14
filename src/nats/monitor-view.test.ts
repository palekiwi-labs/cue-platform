import { describe, expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import type { RegistryRow } from "./events"
import { ActivityLog } from "./monitor-model"
import type { MonitorSource } from "./monitor-source"
import { AgentMonitorView } from "./monitor-view"

const NOW = 1_000_000_000

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme

function fakeTui() {
  let renders = 0
  const tui = { terminal: { rows: 30 }, requestRender: () => renders++ } as unknown as TUI
  return { tui, renders: () => renders }
}

function row(sid: string, over: Partial<RegistryRow> = {}): RegistryRow {
  return { v: 1, sid, host: "h", state: "idle", turns: 0, tokens: 0, cost: 0, started_at: NOW, updated_at: NOW, ...over }
}

function fakeSource(rows: RegistryRow[]) {
  const selections: (string | undefined)[] = []
  let selected: string | undefined
  let closed = false
  const log = new ActivityLog()
  const source: MonitorSource = {
    url: "nats://fake",
    rows: () => rows,
    selected: () => selected,
    activity: () => log,
    select(sid) {
      if (sid === selected) return
      selected = sid
      selections.push(sid)
    },
    async close() {
      closed = true
    },
  }
  return { source, log, selections, closed: () => closed }
}

describe("AgentMonitorView", () => {
  test("lists delegated runs, follows the selection and toggles show-all", async () => {
    const { tui } = fakeTui()
    const fake = fakeSource([
      row("a", { run_id: "run-a", state: "busy" }),
      row("b", { run_id: "run-b", updated_at: NOW - 1000 }),
      row("plain"),
    ])
    fake.log.add({ v: 1, ts: NOW, sid: "a", host: "h", kind: "tool_start", seq: 1, call_id: "c", tool: "bash", args: "ls" })
    let done = false
    const view = new AgentMonitorView(tui, theme, async () => fake.source, () => (done = true), () => NOW)
    await Bun.sleep(0)

    let text = view.render(120).join("\n")
    expect(text).toContain("run-a")
    expect(text).toContain("run-b")
    expect(text).not.toContain("plain")
    expect(text).toContain("..  bash ls")
    expect(fake.selections).toEqual(["a"])

    view.handleInput("j")
    view.render(120)
    expect(fake.selections).toEqual(["a", "b"])

    view.handleInput("a")
    text = view.render(120).join("\n")
    expect(text).toContain("plain")

    view.handleInput("q")
    expect(done).toBe(true)
    expect(fake.closed()).toBe(true)
  })

  test("shows the connection error", async () => {
    const { tui } = fakeTui()
    const view = new AgentMonitorView(
      tui,
      theme,
      async () => {
        throw new Error("cannot connect to NATS at nats://x")
      },
      () => {},
      () => NOW,
    )
    await Bun.sleep(0)
    const lines = view.render(80)
    expect(lines).toHaveLength(30)
    expect(lines.at(-1)).toContain("cannot connect to NATS at nats://x")
    view.close()
  })
})
