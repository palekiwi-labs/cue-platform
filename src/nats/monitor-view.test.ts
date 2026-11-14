import { describe, expect, test } from "bun:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import type { AgentEvent, RegistryRow } from "./events"
import { ActivityLog, RunHistory } from "./monitor-model"
import type { MonitorSource } from "./monitor-source"
import { AgentMonitorView } from "./monitor-view"

const NOW = 1_000_000_000
const B1 = "20261115-100000-aaaaaa"
const B2 = "20261115-110000-bbbbbb"

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme

function fakeTui() {
  const tui = { terminal: { rows: 30 }, requestRender: () => {} } as unknown as TUI
  return { tui }
}

function row(sid: string, over: Partial<RegistryRow> = {}): RegistryRow {
  return { v: 1, sid, host: "h", state: "idle", turns: 0, tokens: 0, cost: 0, started_at: NOW, updated_at: NOW, ...over }
}

let seq = 0
function ev(sid: string, kind: AgentEvent["kind"], fields: Record<string, unknown> = {}): AgentEvent {
  return { v: 1, ts: NOW - 5000, sid, host: "h", kind, seq: ++seq, ...fields }
}

function fakeSource(rows: RegistryRow[], history = new RunHistory()) {
  const selections: (string | undefined)[] = []
  let selected: string | undefined
  let closed = false
  const log = new ActivityLog()
  const source: MonitorSource = {
    url: "nats://fake",
    rows: () => rows,
    registryReady: () => true,
    history: () => history,
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
  test("running view lists live headless runs by batch; tab shows finished runs", async () => {
    const { tui } = fakeTui()
    const live = `${B2}-builder-0`
    const history = new RunHistory()
    for (const sid of [`${B1}-explore-0`, `${B1}-explore-1`]) {
      history.apply(ev(sid, "start", { reason: "startup", cwd: "/w" }))
      history.apply(ev(sid, "end", { reason: "quit", turns: 2, cost: 0.25 }))
    }
    history.apply(ev(`${B1}-explore-1`, "end", { reason: "quit" }))
    const fake = fakeSource([row(live, { run_id: live, state: "busy" }), row("interactive")], history)
    fake.log.add(ev(live, "tool_start", { call_id: "c", tool: "bash", args: "ls" }))
    let done = false
    const view = new AgentMonitorView(tui, theme, async () => fake.source, () => (done = true), () => NOW)
    await Bun.sleep(0)

    let text = view.render(140).join("\n")
    expect(text).toContain("running  1 live / 3 total")
    expect(text).toContain(`- ${B2}`)
    expect(text).toContain("builder-0")
    expect(text).not.toContain(B1)
    expect(text).not.toContain("interactive")
    expect(text).toContain("..  bash ls")
    expect(fake.selections).toEqual([live])

    view.handleInput("\t")
    text = view.render(140).join("\n")
    expect(text).toContain("all runs (7d)")
    expect(text).toContain(`+ ${B1}  explore  2 runs  (2 done)`)
    expect(text).not.toContain("explore-1")

    view.handleInput("j")
    view.handleInput("j")
    view.handleInput("\x1bz")
    text = view.render(140).join("\n")
    expect(text).toContain(`- ${B1}`)
    expect(text).toContain("explore-1")
    view.handleInput("j")
    text = view.render(140).join("\n")
    expect(fake.selections.at(-1)).toBe(`${B1}-explore-0`)
    expect(text).toContain("cwd      /w")

    view.handleInput("\x1bp")
    expect(view.render(140).join("\n")).not.toContain("cwd      /w")

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
