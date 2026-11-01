import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStream, feedLine, parseStream, streamLines, summarizeArgs } from "./stream"
import { EventTail } from "./tail"

const line = (o: unknown) => JSON.stringify(o)

const ev = {
  session: line({ type: "session", version: 3, timestamp: "2026-10-30T03:51:05.602Z" }),
  turnStart: line({ type: "turn_start" }),
  textDelta: (d: string) =>
    line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } }),
  toolcallStart: (id: string, name: string) =>
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id, toolName: name } }),
  toolcallDelta: (id: string, d: string) =>
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", id, delta: d } }),
  toolExecStart: (id: string, name: string, args: unknown) =>
    line({ type: "tool_execution_start", toolCallId: id, toolName: name, args }),
  toolExecEnd: (id: string, name: string, extra: Record<string, unknown> = {}) =>
    line({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [] }, ...extra }),
  assistantEnd: (usage?: unknown) =>
    line({
      type: "message_end",
      message: { role: "assistant", content: [], ...(usage !== undefined ? { usage } : {}) },
    }),
}

const usage = {
  input: 100,
  output: 50,
  cacheRead: 200,
  cacheWrite: 0,
  cost: { total: 0.02 },
}

describe("feedLine", () => {
  test("tool call pairs by id, not order", () => {
    const s = createStream()
    feedLine(s, ev.turnStart)
    feedLine(s, ev.toolExecStart("a", "read", { path: "/x.ts" }))
    feedLine(s, ev.toolExecStart("b", "bash", { command: "ls" }))
    feedLine(s, ev.toolExecEnd("b", "bash", { durationMs: 120, result: { content: [], structuredContent: { exit_code: 0 } } }))
    const tools = s.items.filter((i) => i.kind === "tool")
    expect(tools).toHaveLength(2)
    const b = tools[1]!
    expect(b).toMatchObject({ kind: "tool", name: "bash", state: "ok", ms: 120 })
    expect((tools[0] as { state: string }).state).toBe("pending")
  })

  test("bash error via exit code", () => {
    const s = createStream()
    feedLine(s, ev.toolExecStart("a", "bash", { command: "false" }))
    feedLine(s, ev.toolExecEnd("a", "bash", { result: { content: [], structuredContent: { exit_code: 127 } } }))
    expect(s.items[0]).toMatchObject({ kind: "tool", state: "error", detail: "exit 127" })
  })

  test("tool error renders first line of the result", () => {
    const s = createStream()
    feedLine(s, ev.toolExecStart("a", "read", { path: "/nope" }))
    feedLine(
      s,
      ev.toolExecEnd("a", "read", {
        isError: true,
        result: { content: [{ type: "text", text: "ENOENT: no such file\nsecond line" }] },
      }),
    )
    expect(s.items[0]).toMatchObject({ kind: "tool", state: "error", detail: "ENOENT: no such file" })
  })

  test("turn usage comes from the assistant message_end", () => {
    const s = createStream()
    feedLine(s, ev.turnStart)
    feedLine(s, ev.textDelta("hello "))
    feedLine(s, ev.textDelta("world"))
    feedLine(s, ev.assistantEnd(usage))
    const text = s.items.find((i) => i.kind === "text")
    expect(text).toMatchObject({ kind: "text", chars: 11, done: true })
    const turn = s.items.find((i) => i.kind === "turn")
    expect(turn).toMatchObject({ kind: "turn", inTokens: 300, outTokens: 50, costUsd: 0.02 })
  })

  test("composing row is replaced by the executed tool", () => {
    const s = createStream()
    feedLine(s, ev.toolcallStart("t1", "write"))
    feedLine(s, ev.toolcallDelta("t1", "x".repeat(100)))
    feedLine(s, ev.toolExecStart("t1", "write", { path: "/a", content: "x".repeat(100) }))
    expect(s.items.filter((i) => i.kind === "composing")).toHaveLength(0)
    expect(s.items[0]).toMatchObject({ kind: "tool", name: "write" })
  })

  test("malformed lines are skipped, not thrown", () => {
    const s = createStream()
    feedLine(s, "not json")
    feedLine(s, ev.turnStart)
    expect(s.skipped).toBe(1)
    expect(s.items).toHaveLength(1)
  })

  test("agent_settled notice records aborts", () => {
    const s = createStream()
    feedLine(s, line({ type: "agent_settled", aborted: true }))
    expect(s.items[0]).toMatchObject({ kind: "notice", tone: "bad" })
  })
})

describe("summarizeArgs", () => {
  test.each([
    ["read", { path: "/a.ts", offset: 10, limit: 20 }, "/a.ts @10+20"],
    ["bash", { command: "rg -n foo\n|| true" }, "rg -n foo"],
    ["edit", { path: "/a.ts", edits: [{}, {}] }, "/a.ts (2 edits)"],
    ["write", { path: "/a.ts", content: "x".repeat(50) }, "/a.ts (50 chars)"],
    ["grep", { pattern: "foo", path: "/src" }, "/foo/ /src"],
    ["cue-log", { context: "c", title: "T" }, "c: T"],
    ["unknown", { path: "/a", query: "q", more: 1 }, "path=/a query=q"],
  ])("%s", (tool, args, want) => {
    expect(summarizeArgs(tool as string, args)).toBe(want)
  })
})

describe("streamLines", () => {
  test("pending tools read as abandoned on finished runs", () => {
    const s = createStream()
    feedLine(s, ev.turnStart)
    feedLine(s, ev.toolExecStart("a", "read", { path: "/x" }))
    const live = streamLines(s.items, true, 80)
    expect(live[1]![0]).toMatchObject({ text: "  ◌ ", tone: "live" })
    const done = streamLines(s.items, false, 80)
    expect(done[1]![0]).toMatchObject({ tone: "bad" })
    expect(done[1]!.map((seg) => seg.text).join("")).toContain("no result (harness exited)")
  })

  test("lines truncate to width", () => {
    const s = createStream()
    feedLine(s, ev.toolExecStart("a", "read", { path: "/".repeat(300) }))
    for (const l of streamLines(s.items, true, 40)) {
      expect(l.map((seg) => seg.text).join("").length).toBeLessThanOrEqual(40)
    }
  })
})

describe("EventTail", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test("reads appended bytes only, keeps partial lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cue-tail-"))
    dirs.push(dir)
    const path = join(dir, "events.jsonl")
    const start = ev.toolExecStart("a", "read", { path: "/x" })
    writeFileSync(path, `${ev.session}\n${ev.turnStart}\n${start.slice(0, 20)}`)
    const tail = new EventTail(path)
    expect(await tail.poll()).toBe(true)
    expect(tail.items()).toHaveLength(1) // partial tool_execution_start held back
    appendFileSync(path, `${start.slice(20)}\n`)
    expect(await tail.poll()).toBe(true)
    const items = tail.items()
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ kind: "tool", name: "read" })
    expect(await tail.poll()).toBe(false)
  })

  const tmpFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "cue-tail-"))
    dirs.push(dir)
    return join(dir, "events.jsonl")
  }

  test("concurrent polls read each byte once", async () => {
    const path = tmpFile()
    writeFileSync(path, `${ev.session}\n${ev.turnStart}\n${ev.turnStart}\n`)
    const tail = new EventTail(path)
    await Promise.all([tail.poll(), tail.poll(), tail.poll()])
    expect(tail.items()).toHaveLength(2)
  })

  test("a truncated and rewritten file restarts the timeline", async () => {
    const path = tmpFile()
    writeFileSync(path, `${ev.session}\n${ev.turnStart}\n${ev.turnStart}\n`)
    const tail = new EventTail(path)
    await tail.poll()
    writeFileSync(path, `${ev.turnStart}\n`)
    expect(await tail.poll()).toBe(true)
    expect(tail.items()).toHaveLength(1)
    expect(tail.items()[0]).toMatchObject({ kind: "turn", index: 1 })
  })

  test("a multibyte character split across reads survives", async () => {
    const path = tmpFile()
    const bytes = Buffer.from(`${ev.turnStart}\n${ev.textDelta("héllo")}\n`)
    const cut = bytes.indexOf(Buffer.from("é")) + 1
    writeFileSync(path, bytes.subarray(0, cut))
    const tail = new EventTail(path)
    await tail.poll()
    appendFileSync(path, bytes.subarray(cut))
    await tail.poll()
    expect(tail.items()[1]).toMatchObject({ kind: "text", head: "héllo" })
  })

  test("parseStream equals line-by-line feeding", () => {
    const text = [
      ev.session,
      ev.turnStart,
      ev.textDelta("a"),
      ev.toolcallStart("t", "read"),
      ev.toolExecStart("t", "read", { path: "/x" }),
      ev.toolExecEnd("t", "read", { durationMs: 5 }),
      ev.assistantEnd(usage),
      line({ type: "agent_settled", aborted: false }),
    ].join("\n")
    const whole = parseStream(text)
    const pieced = createStream()
    for (const l of text.split("\n")) feedLine(pieced, l)
    expect(whole.items).toEqual(pieced.items)
    expect(whole.startedAt).toBe(Date.parse("2026-10-30T03:51:05.602Z"))
  })
})

describe("feedLine boundaries", () => {
  test("non-object JSON lines are skipped", () => {
    const s = createStream()
    for (const l of ["null", "42", '"x"', "true", ev.turnStart]) feedLine(s, l)
    expect(s.skipped).toBe(4)
    expect(s.items).toHaveLength(1)
  })
})
