import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { fallbackDescription, parseSession, type SessionRow, sessionMeta } from "../browser/sessions"
import { loadSessionRows, MAX_CONCURRENT_SESSION_LOADS, sessionFiles } from "./session-files"

const root = mkdtempSync(join(tmpdir(), "session-files-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
const header = (cwd: string, timestamp = "2026-01-01T00:00:00.000Z") =>
  ({ type: "session", version: 3, id: "s", timestamp, cwd })
let n = 0
const linked = (entries: Record<string, unknown>[]) => {
  let parentId: string | null = null
  return entries.map((e) => {
    const id = `e${++n}`
    const out = { id, parentId, timestamp: "2026-01-02T00:00:00.000Z", ...e }
    parentId = id
    return out
  })
}
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }

const fixtures: Record<string, string> = {
  "named.jsonl": jsonl(header("/w/a"), ...linked([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first\nask" }, { type: "text", text: "more" }], timestamp: 1767225600000 } },
    { type: "session_info", name: " Named " },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage, timestamp: 1767312000000 } },
    { type: "custom_message", customType: "cue-context", details: { address: "o/r/c" } },
    { type: "label", targetId: "e1", label: "star" },
  ])),
  "cleared.jsonl": jsonl(header("/w/b"), ...linked([
    { type: "session_info", name: "gone" },
    { type: "message", message: { role: "user", content: "plain text" } },
    { type: "session_info", name: "  " },
    { type: "custom", customType: "session-description", data: { text: " described " } },
  ])),
  "empty.jsonl": jsonl(header("/w/c", "2026-03-01T00:00:00.000Z")),
  "no-header-time.jsonl": jsonl({ type: "session", id: "s", cwd: "/w/d" }),
  "tool-only.jsonl": jsonl(header("/w/e"), ...linked([
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x" }], timestamp: 1999999999999 } },
    { type: "message", message: { role: "user", content: [{ type: "image" }], timestamp: 1767225600000 } },
  ])) + "{broken\n",
  "headless.jsonl": jsonl({ type: "message", message: { role: "user", content: "x" } }),
}

describe("parseSession", () => {
  const dir = join(root, "parity")
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(fixtures)) writeFileSync(join(dir, name), content)
  utimesSync(join(dir, "no-header-time.jsonl"), 1700000000, 1700000000)

  test("matches pi's session list and the previous metadata parse", async () => {
    const infos = await SessionManager.listAll(dir)
    expect(infos.map((i) => i.path).sort()).toEqual(
      Object.keys(fixtures).filter((f) => f !== "headless.jsonl").map((f) => join(dir, f)).sort(),
    )
    for (const info of infos) {
      const content = fixtures[info.path.slice(dir.length + 1)]!
      const parsed = parseSession(content)!
      expect(parsed.cwd).toBe(info.cwd)
      expect(parsed.name).toBe(info.name)
      expect(parsed.firstMessage || "(no messages)").toBe(info.firstMessage)
      expect(parsed.modified ?? 1700000000000).toBe(info.modified.getTime())
      expect(parsed.meta).toEqual(sessionMeta(content))
    }
  })

  test("derives every row field from one parse", () => {
    const named = parseSession(fixtures["named.jsonl"]!)!
    expect(named).toMatchObject({ cwd: "/w/a", name: "Named", firstMessage: "first\nask more", modified: 1767312000000 })
    expect(named.meta).toMatchObject({ address: "o/r/c", label: "star" })
    expect(named.meta.tokens).toBeGreaterThan(0)
    expect(fallbackDescription(named.name, named.firstMessage)).toBe("Named")
    const cleared = parseSession(fixtures["cleared.jsonl"]!)!
    expect(cleared.name).toBeUndefined()
    expect(cleared.meta.description).toBe("described")
    expect(fallbackDescription(cleared.name, cleared.firstMessage)).toBe("plain text")
    expect(fallbackDescription(undefined, "")).toBe("(no messages)")
    expect(parseSession(fixtures["headless.jsonl"]!)).toBeNull()
  })
})

describe("sessionFiles", () => {
  test("lists jsonl files of every project dir, newest name first", async () => {
    const dir = join(root, "sessions")
    for (const [project, files] of [["p1", ["2026-01-01_a.jsonl", "2026-03-01_c.jsonl", "x.txt"]], ["p2", ["2026-02-01_b.jsonl"]]] as const) {
      mkdirSync(join(dir, project), { recursive: true })
      for (const f of files) writeFileSync(join(dir, project, f), "")
    }
    writeFileSync(join(dir, "stray.jsonl"), "")
    expect(await sessionFiles(dir)).toEqual([
      join(dir, "p1", "2026-03-01_c.jsonl"),
      join(dir, "p2", "2026-02-01_b.jsonl"),
      join(dir, "p1", "2026-01-01_a.jsonl"),
    ])
    expect(await sessionFiles(join(root, "missing"))).toEqual([])
  })
})

describe("loadSessionRows", () => {
  const row = (path: string, modified: number): SessionRow =>
    ({ path, cwd: "/w", description: path, tokens: null, modified })
  const paths = Array.from({ length: 25 }, (_, i) => `p${i}`)

  test("publishes after the first file, every ten and at the end, newest first", async () => {
    const published: { loaded: number; total: number; rows?: string[] }[] = []
    const rows = await loadSessionRows(
      paths,
      async (p) => (p === "p3" ? null : row(p, Number(p.slice(1)))),
      (list) => list.filter((r) => r.path !== "p4"),
      (loaded, total, partial) => published.push({ loaded, total, rows: partial?.map((r) => r.path) }),
    )
    expect(published.map((p) => p.loaded)).toEqual(paths.map((_, i) => i + 1))
    expect(published.every((p) => p.total === 25)).toBe(true)
    expect(published.filter((p) => p.rows).map((p) => p.loaded)).toEqual([1, 10, 20, 25])
    expect(published[0]!.rows).toEqual(["p0"])
    expect(published[9]!.rows).toEqual(["p9", "p8", "p7", "p6", "p5", "p2", "p1", "p0"])
    expect(rows.map((r) => r.path)).toEqual(published[24]!.rows!)
    expect(rows).toHaveLength(23)
  })

  test("reads at most ten files at once, in path order, skipping failures", async () => {
    let active = 0
    let peak = 0
    const started: string[] = []
    const rows = await loadSessionRows(paths, async (p) => {
      started.push(p)
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      if (p === "p7") throw new Error("unreadable")
      return row(p, 0)
    })
    expect(peak).toBe(MAX_CONCURRENT_SESSION_LOADS)
    expect(started).toEqual(paths)
    expect(rows).toHaveLength(24)
  })
})
