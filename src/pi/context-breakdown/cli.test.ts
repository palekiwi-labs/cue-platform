import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { latestSession, main, parseArgs, sessionDir } from "./cli"
import { buildSnapshot, SNAPSHOT_TYPE } from "./snapshot"

const root = mkdtempSync(join(tmpdir(), "cb-cli-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function session(name: string, prompt: string | null, tools: string[] = ["read"]): string {
  const lines: unknown[] = [{ type: "session", id: name, timestamp: "2026-01-01T00:00:00Z", cwd: "/w" }]
  let parent: string | null = null
  const push = (e: Record<string, unknown>) => {
    const id = `${name}${lines.length}`
    lines.push({ id, parentId: parent, timestamp: "2026-01-01T00:00:01Z", ...e })
    parent = id
  }
  if (prompt !== null) {
    const snap = buildSnapshot({ systemPrompt: prompt, tools: tools.map((t) => ({ name: t })), model: "p/m" })
    push({ type: "custom", customType: SNAPSHOT_TYPE, data: snap })
  }
  push({ type: "message", message: { role: "user", content: "hello" } })
  push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "p",
      model: "m",
      timestamp: Date.parse("2026-01-01T00:00:02Z"),
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 1000 },
    },
  })
  const file = join(root, `${name}.jsonl`)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return file
}

function run(argv: string[]): { code: number; text: string } {
  const out: string[] = []
  const code = main(argv, (s) => out.push(s))
  return { code, text: out.join("\n") }
}

describe("cli", () => {
  test("sessionDir encodes the cwd like pi", () => {
    expect(sessionDir("/home/pl/code/x", "/a")).toBe("/a/sessions/--home-pl-code-x--")
  })

  test("latestSession picks the newest file", () => {
    const dir = sessionDir("/proj", root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "old.jsonl"), "")
    writeFileSync(join(dir, "new.jsonl"), "")
    utimesSync(join(dir, "old.jsonl"), 1, 1)
    expect(latestSession("/proj", root)).toBe(join(dir, "new.jsonl"))
    expect(latestSession("/none", root)).toBeNull()
  })

  test("parseArgs requires a session and rejects unknown options", () => {
    expect(() => parseArgs([])).toThrow("usage")
    expect(() => parseArgs(["--nope"])).toThrow("unknown option")
    expect(parseArgs(["f.jsonl", "--json", "--turns", "all"])).toMatchObject({ file: "f.jsonl", json: true, turns: "all" })
  })

  test("a session without a snapshot reports the prefix as unknown", () => {
    const r = run([session("bare", null)])
    expect(r.code).toBe(0)
    expect(r.text).toContain("static prefix unknown")
  })

  test("--compare lists changed sections and tools", () => {
    const a = session("a", "<cwd>/a</cwd>")
    const b = session("b", "<cwd>/b</cwd>", ["read", "bash"])
    const r = run([b, "--compare", a])
    expect(r.text).toContain("cache-bust candidates")
    expect(r.text).toContain("section preamble changed")
    expect(r.text).toContain("tool bash added")
    expect(run([a, "--compare", a]).text).toContain("identical static prefix")
  })

  test("--json prints a parseable report", () => {
    const r = run([session("j", "x"), "--json"])
    const data = JSON.parse(r.text)
    expect(data.breakdown.exact).toBe(1010)
    expect(data.cache.turns).toHaveLength(1)
  })
})
