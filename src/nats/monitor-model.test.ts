import { describe, expect, test } from "bun:test"
import type { AgentEvent, RegistryRow } from "./events"
import {
  ActivityLog,
  applyRegistryEntry,
  formatActivity,
  formatAge,
  formatRun,
  groupRuns,
  parseRunId,
  RunHistory,
  runCost,
  runModel,
  runNote,
  runViews,
} from "./monitor-model"

const NOW = 1_000_000_000

function row(over: Partial<RegistryRow> = {}): RegistryRow {
  return {
    v: 1,
    sid: "s1",
    host: "h",
    state: "idle",
    turns: 0,
    tokens: 0,
    cost: 0,
    started_at: NOW - 60_000,
    updated_at: NOW,
    ...over,
  }
}

function put(key: string, value: unknown) {
  return { key, operation: "PUT", value: () => JSON.stringify(value) }
}

let seq = 0
function ev(kind: AgentEvent["kind"], fields: Record<string, unknown> = {}): AgentEvent {
  return { v: 1, ts: NOW, sid: "s1", host: "h", kind, seq: ++seq, ...fields }
}

describe("applyRegistryEntry", () => {
  test("PUT upserts, DEL and PURGE remove", () => {
    const rows = new Map<string, RegistryRow>()
    applyRegistryEntry(rows, put("a", row({ sid: "a" })))
    applyRegistryEntry(rows, put("b", row({ sid: "b" })))
    applyRegistryEntry(rows, put("a", row({ sid: "a", turns: 3 })))
    expect(rows.get("a")?.turns).toBe(3)
    applyRegistryEntry(rows, { key: "a", operation: "DEL", value: () => "" })
    applyRegistryEntry(rows, { key: "b", operation: "PURGE", value: () => "" })
    expect(rows.size).toBe(0)
  })

  test("malformed values remove the row", () => {
    const rows = new Map<string, RegistryRow>()
    applyRegistryEntry(rows, put("a", row({ sid: "a" })))
    applyRegistryEntry(rows, { key: "a", operation: "PUT", value: () => "{not json" })
    expect(rows.has("a")).toBe(false)
  })
})

const B1 = "20261115-100000-aaaaaa"
const B2 = "20261115-110000-bbbbbb"

function runEv(sid: string, kind: AgentEvent["kind"], fields: Record<string, unknown> = {}): AgentEvent {
  return { v: 1, ts: NOW - 30_000, sid, host: "h", kind, seq: ++seq, ...fields }
}

describe("runs", () => {
  test("parseRunId splits batch, agent and position", () => {
    expect(parseRunId(`${B1}-code-reviewer-2`)).toEqual({
      runId: `${B1}-code-reviewer-2`,
      batch: B1,
      agent: "code-reviewer",
      pos: 2,
    })
    expect(parseRunId("interactive-session")).toBeUndefined()
  })

  test("derives finished statuses from history", () => {
    const h = new RunHistory()
    const done = `${B1}-builder-0`
    const failed = `${B1}-builder-1`
    const aborted = `${B1}-builder-2`
    const lost = `${B1}-builder-3`
    const recovered = `${B1}-builder-4`
    for (const sid of [done, failed, aborted, lost, recovered]) {
      h.apply(runEv(sid, "start", { reason: "startup", cwd: "/w", model: "m1" }))
      h.apply(runEv(sid, "input", { source: "user", preview: "go", model: "m2", context: "c" }))
    }
    h.apply(runEv(failed, "error", { message: "rate limited" }))
    h.apply(runEv(failed, "settled", { aborted: false }))
    h.apply(runEv(aborted, "settled", { aborted: true }))
    h.apply(runEv(recovered, "error", { message: "x" }))
    h.apply(runEv(recovered, "input", { source: "user", preview: "again" }))
    for (const sid of [done, failed, aborted, recovered]) h.apply(runEv(sid, "end", { reason: "quit", turns: 2, cost: 0.1 }))
    h.apply(runEv("plain-session", "start", { reason: "startup" }))

    const views = runViews(h, [], NOW)
    const status = Object.fromEntries(views.map((v) => [v.id.runId, v.status]))
    expect(status).toEqual({ [done]: "done", [failed]: "failed", [aborted]: "aborted", [lost]: "lost", [recovered]: "done" })
    const d = views.find((v) => v.id.runId === done)!
    expect([d.live, runModel(d), d.record?.context, d.record?.cwd, runCost(d)]).toEqual([false, "m2", "c", "/w", 0.1])
    expect(runNote(views.find((v) => v.id.runId === failed)!)).toBe("rate limited")
  })

  test("a live registry row wins over history; stale rows and interactive sessions are dropped", () => {
    const h = new RunHistory()
    const a = `${B1}-builder-0`
    h.apply(runEv(a, "start", { reason: "startup" }))
    const views = runViews(
      h,
      [
        row({ sid: a, run_id: a, state: "busy", last_tool: "bash ls" }),
        row({ sid: `${B2}-explore-0`, run_id: `${B2}-explore-0`, updated_at: NOW - 121_000 }),
        row({ sid: "interactive" }),
      ],
      NOW,
    )
    expect(views.map((v) => [v.id.runId, v.status, v.live])).toEqual([[a, "busy", true]])
    expect(formatRun(views[0]!, NOW)).toContain("bash ls")
  })

  test("groups by batch newest first, runs by position; running keeps live runs", () => {
    const h = new RunHistory()
    for (const sid of [`${B1}-b-1`, `${B1}-a-0`, `${B2}-x-0`]) {
      h.apply(runEv(sid, "start", { reason: "startup" }))
      h.apply(runEv(sid, "end", { reason: "quit" }))
    }
    const views = runViews(h, [row({ sid: `${B1}-c-2`, run_id: `${B1}-c-2`, state: "idle" })], NOW)
    const all = groupRuns(views, false).map((b) => [b.batch, b.runs.map((r) => r.id.pos)])
    expect(all).toEqual([
      [B2, [0]],
      [B1, [0, 1, 2]],
    ])
    expect(groupRuns(views, true).map((b) => [b.batch, b.runs.map((r) => r.id.runId)])).toEqual([[B1, [`${B1}-c-2`]]])
  })

  test("formatRun shows status, agent-pos, model, turns, cost and age", () => {
    const h = new RunHistory()
    const id = `${B1}-builder-3`
    h.apply(runEv(id, "start", { reason: "startup", model: "opus" }))
    h.apply(runEv(id, "end", { reason: "quit", turns: 4, cost: 0.12345 }))
    const line = formatRun(runViews(h, [], NOW)[0]!, NOW)
    for (const part of ["done", "builder-3", "opus", "t4", "$0.123", "30s"]) expect(line).toContain(part)
  })
})

describe("format", () => {
  test("formatAge", () => {
    expect(formatAge(5_000)).toBe("5s")
    expect(formatAge(125_000)).toBe("2m")
    expect(formatAge(3 * 3600_000)).toBe("3h")
    expect(formatAge(-10)).toBe("0s")
  })
})

describe("ActivityLog", () => {
  test("pairs tool_start with tool_end by call id", () => {
    const log = new ActivityLog()
    log.add(ev("input", { source: "user", preview: "do it" }))
    log.add(ev("turn_start", { turn: 0 }))
    log.add(ev("thinking"))
    log.add(ev("tool_start", { call_id: "c1", tool: "bash", args: "ls" }))
    log.add(ev("tool_start", { call_id: "c2", tool: "read", args: "a.ts" }))
    log.add(ev("tool_end", { call_id: "c1", tool: "bash", ok: true, duration_ms: 12 }))
    log.add(ev("tool_end", { call_id: "c2", tool: "read", ok: false, duration_ms: 1500 }))
    log.add(ev("tool_start", { call_id: "c3", tool: "grep", args: "x" }))
    expect(log.items.map(formatActivity)).toEqual([
      "> [user] do it",
      "thinking",
      "ok  bash ls (12ms)",
      "ERR read a.ts (1.5s)",
      "..  grep x",
    ])
  })

  test("errors, settled, compact and end", () => {
    const log = new ActivityLog()
    log.add(ev("error", { message: "boom" }))
    log.add(ev("settled", { aborted: true }))
    log.add(ev("compact", { reason: "threshold" }))
    log.add(ev("end", { reason: "quit", turns: 3, cost: 0.5 }))
    expect(log.items.map(formatActivity)).toEqual([
      "error: boom",
      "settled (aborted)",
      "compact (threshold)",
      "end (quit) 3 turns, $0.500",
    ])
  })

  test("keeps only the last N items", () => {
    const log = new ActivityLog(3)
    for (let i = 0; i < 5; i++) log.add(ev("input", { source: "user", preview: `p${i}` }))
    expect(log.items.map(formatActivity)).toEqual(["> [user] p2", "> [user] p3", "> [user] p4"])
  })
})
