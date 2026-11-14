import { describe, expect, test } from "bun:test"
import type { AgentEvent, RegistryRow } from "./events"
import {
  ActivityLog,
  applyRegistryEntry,
  formatActivity,
  formatAge,
  formatRow,
  sortRows,
  visibleRows,
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

describe("rows", () => {
  test("active states first, then most recent", () => {
    const sorted = sortRows([
      row({ sid: "idle-new", state: "idle", updated_at: NOW }),
      row({ sid: "busy-old", state: "busy", updated_at: NOW - 5000 }),
      row({ sid: "err", state: "error", updated_at: NOW - 1000 }),
      row({ sid: "idle-old", state: "idle", updated_at: NOW - 2000 }),
    ])
    expect(sorted.map((r) => r.sid)).toEqual(["err", "busy-old", "idle-new", "idle-old"])
  })

  test("by default only delegated runs; show-all includes every session", () => {
    const rows = [row({ sid: "a", run_id: "run-a" }), row({ sid: "b" })]
    expect(visibleRows(rows, { showAll: false, now: NOW }).map((r) => r.sid)).toEqual(["a"])
    expect(visibleRows(rows, { showAll: true, now: NOW }).map((r) => r.sid).sort()).toEqual(["a", "b"])
  })

  test("stale rows are hidden", () => {
    const rows = [
      row({ sid: "fresh", run_id: "r1", updated_at: NOW - 119_000 }),
      row({ sid: "stale", run_id: "r2", updated_at: NOW - 121_000 }),
    ]
    expect(visibleRows(rows, { showAll: true, now: NOW }).map((r) => r.sid)).toEqual(["fresh"])
  })

  test("formatRow shows state, id, model, turns, cost, age and last tool", () => {
    const line = formatRow(
      row({ state: "busy", run_id: "run-1", model: "opus", turns: 4, cost: 0.12345, last_tool: "bash ls" }),
      NOW,
    )
    expect(line).toContain("busy")
    expect(line).toContain("run-1")
    expect(line).toContain("opus")
    expect(line).toContain("t4")
    expect(line).toContain("$0.123")
    expect(line).toContain("1m")
    expect(line.endsWith("bash ls")).toBe(true)
    expect(formatRow(row({ sid: "only-sid" }), NOW)).toContain("only-sid")
  })

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
