import { describe, expect, test } from "bun:test"
import {
  argPreview,
  encodeEvent,
  eventSubject,
  messageError,
  messageUsage,
  registrySubject,
  resolveJsDomain,
  runIdOf,
  SessionTracker,
  subjectToken,
  truncate,
} from "./events"

function tracker(sid = "s1") {
  let t = 1000
  const clock = () => t
  const tr = new SessionTracker({ sid, host: "casm" }, clock)
  return { tr, tick: (ms: number) => (t += ms) }
}

describe("subjects", () => {
  test("event subject and registry key sanitise the sid", () => {
    expect(eventSubject("a.b*c", "turn_end")).toBe("agent.evt.a_b_c.turn_end")
    expect(registrySubject("019a-ff")).toBe("$KV.agents.019a-ff")
    expect(subjectToken("")).toBe("_")
  })

  test("js domain defaults to pale and can be cleared", () => {
    expect(resolveJsDomain({})).toBe("pale")
    expect(resolveJsDomain({ CUE_NATS_JS_DOMAIN: " other " })).toBe("other")
    expect(resolveJsDomain({ CUE_NATS_JS_DOMAIN: "" })).toBeUndefined()
  })
})

describe("runIdOf", () => {
  test("recognises cue-agent run ids", () => {
    expect(runIdOf("20261114-134753-ae2a53-builder-1")).toBe("20261114-134753-ae2a53-builder-1")
    expect(runIdOf("019a3c1e-7f2b-7000-8000-123456789abc")).toBeUndefined()
  })
})

describe("previews", () => {
  test("truncate flattens whitespace and caps length", () => {
    expect(truncate("a\n  b", 10)).toBe("a b")
    expect(truncate("abcdef", 4)).toBe("abc\u2026")
  })

  test("tool argument previews pick the meaningful field", () => {
    expect(argPreview("bash", { command: "ls -la" })).toBe("ls -la")
    expect(argPreview("read", { path: "src/x.ts", offset: 3 })).toBe("src/x.ts")
    expect(argPreview("cue-log", { title: "t" })).toBe('{"title":"t"}')
    expect(argPreview("bash", { command: "x".repeat(1000) }).length).toBe(300)
  })

  test("oversized events are shrunk below the limit", () => {
    const { tr } = tracker()
    const ev = tr.input("y".repeat(100), "user")
    ev.extra = "z".repeat(20000)
    const json = encodeEvent(ev, 8192)
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(8192)
    expect(JSON.parse(json).kind).toBe("input")
  })
})

describe("usage", () => {
  test("reads tokens and cost from assistant messages only", () => {
    expect(messageUsage({ role: "assistant", usage: { totalTokens: 50, cost: { total: 0.25 } } })).toEqual({
      tokens: 50,
      cost: 0.25,
    })
    expect(messageUsage({ role: "user" })).toEqual({ tokens: 0, cost: 0 })
    expect(messageError({ role: "assistant", stopReason: "error", errorMessage: "boom" })).toBe("boom")
    expect(messageError({ role: "assistant", stopReason: "stop" })).toBeUndefined()
  })
})

describe("SessionTracker", () => {
  test("drives state, turns and totals", () => {
    const { tr, tick } = tracker()
    expect(tr.row.state).toBe("idle")
    const input = tr.input("do it", "user")
    expect(input).toMatchObject({ kind: "input", seq: 1, preview: "do it", sid: "s1", host: "casm", v: 1 })
    expect(tr.row.state).toBe("busy")
    tr.turnStart(0)
    expect(tr.thinking()?.kind).toBe("thinking")
    expect(tr.thinking()).toBeUndefined()
    tr.toolStart("c1", "bash", { command: "ls" })
    expect(tr.row.last_tool).toBe("bash ls")
    tick(40)
    expect(tr.toolEnd("c1", "bash", false)).toMatchObject({ ok: true, duration_ms: 40 })
    tr.turnEnd(0, { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.1 } } })
    tr.turnStart(1)
    expect(tr.thinking()).toBeDefined()
    tr.turnEnd(1, { role: "assistant", usage: { totalTokens: 5, cost: { total: 0.05 } } })
    expect(tr.row.turns).toBe(2)
    expect(tr.row.tokens).toBe(15)
    expect(tr.row.cost).toBeCloseTo(0.15)
    tr.settled(false)
    expect(tr.row.state).toBe("idle")
    expect(tr.row.updated_at).toBe(1040)
  })

  test("error persists through settle until the next input", () => {
    const { tr } = tracker()
    tr.input("x", "user")
    tr.error("rate limited")
    tr.settled(false)
    expect(tr.row.state).toBe("error")
    expect(tr.row.error).toBe("rate limited")
    tr.input("again", "user")
    expect(tr.row.state).toBe("busy")
    expect(tr.row.error).toBeUndefined()
  })

  test("waiting-input toggles back to busy", () => {
    const { tr } = tracker()
    tr.input("x", "user")
    tr.waitingInput(true)
    expect(tr.row.state).toBe("waiting-input")
    tr.waitingInput(false)
    expect(tr.row.state).toBe("busy")
  })

  test("message ids differ across processes resuming one session", () => {
    let t = 1
    const a = new SessionTracker({ sid: "s", host: "h" }, () => t)
    t = 2
    const b = new SessionTracker({ sid: "s", host: "h" }, () => t)
    expect(a.msgId(a.start("startup"))).not.toBe(b.msgId(b.start("resume")))
  })
})
