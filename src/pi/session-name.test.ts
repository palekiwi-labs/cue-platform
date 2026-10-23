import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE } from "./lib/current-context"
import { applyContextName, latestFileSessionName, registerSessionNaming } from "./session-name"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Tests run with piped stdio; force the tty-owns-pane guard on. */
function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const stdout = process.stdout as { isTTY?: boolean }
  const had = "isTTY" in stdout
  const prev = stdout.isTTY
  Object.defineProperty(stdout, "isTTY", { value: true, configurable: true })
  return fn().finally(() => {
    if (had) Object.defineProperty(stdout, "isTTY", { value: prev, configurable: true })
    else delete stdout.isTTY
  })
}

function makePi() {
  const names: string[] = []
  const execs: { cmd: string; args: string[] }[] = []
  const handlers: Record<string, (e: unknown, ctx: unknown) => Promise<void>> =
    {}
  let current: string | undefined
  const pi = {
    getSessionName: () => current,
    setName: (n: string) => (current = n),
    setSessionName: (n: string) => names.push(n),
    exec: async (cmd: string, args: string[]) => {
      execs.push({ cmd, args })
      return { stdout: "", stderr: "", code: 0, killed: false }
    },
    on: (ev: string, h: (e: unknown, ctx: unknown) => Promise<void>) => {
      handlers[ev] = h
    },
  } as unknown as ExtensionAPI
  return { pi, names, execs, handlers }
}

describe("applyContextName", () => {
  test("outside tmux only names the session", async () => {
    const m = makePi()
    await applyContextName(m.pi, "a/b/slug", {})
    expect(m.names).toEqual(["slug"])
    expect(m.execs).toEqual([])
  })

  test("inside tmux renames this pane's window", async () => {
    const m = makePi()
    await withTTY(() =>
      applyContextName(m.pi, "a/b/slug", { TMUX: "x", TMUX_PANE: "%3" }),
    )
    expect(m.execs).toEqual([
      { cmd: "tmux", args: ["rename-window", "-t", "%3", "slug"] },
    ])
  })

  test("non-tty child pi (subagent) never renames the window", async () => {
    const m = makePi()
    await applyContextName(m.pi, "a/b/slug", { TMUX: "x", TMUX_PANE: "%3" })
    expect(m.execs).toEqual([])
    expect(m.names).toEqual(["slug"])
  })

  test("tmux failure is swallowed", async () => {
    const m = makePi()
    ;(m.pi as any).exec = async () => {
      throw new Error("no tmux")
    }
    await applyContextName(m.pi, "a/b/slug", { TMUX: "x" })
    expect(m.names).toEqual(["slug"])
  })
})

describe("latestFileSessionName", () => {
  test("returns the last session_info entry in file order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cue-pi-"))
    const file = join(dir, "session.jsonl")
    await writeFile(
      file,
      [
        JSON.stringify({ type: "message", id: "1" }),
        JSON.stringify({ type: "session_info", id: "2", name: "old" }),
        JSON.stringify({ type: "message", id: "3" }),
        JSON.stringify({ type: "session_info", id: "4", name: "new" }),
        "",
      ].join("\n"),
    )
    expect(await latestFileSessionName(file)).toBe("new")
  })

  test("missing file yields undefined", async () => {
    expect(await latestFileSessionName("/nonexistent/x.jsonl")).toBeUndefined()
  })
})

describe("registerSessionNaming", () => {
  const ctx = (branch: unknown[]) => ({
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => undefined,
    },
  })

  test("session_start and session_tree name after the current context", async () => {
    const m = makePi()
    registerSessionNaming(m.pi, {})
    const inj = {
      type: "custom_message",
      customType: CUE_CONTEXT_TYPE,
      details: { address: "a/b/ctx" },
    }
    await m.handlers.session_start!({}, ctx([inj]))
    await m.handlers.session_tree!({}, ctx([inj]))
    expect(m.names).toEqual(["ctx", "ctx"])
  })

  test("no current context: session name untouched, window reset to pi", async () => {
    const m = makePi()
    registerSessionNaming(m.pi, { TMUX: "x", TMUX_PANE: "%1" })
    await withTTY(() => m.handlers.session_start!({}, ctx([{ type: "message" }])))
    expect(m.names).toEqual([])
    expect(m.execs).toEqual([
      { cmd: "tmux", args: ["rename-window", "-t", "%1", "pi"] },
    ])
  })

  test("session rename propagates to the tmux window", async () => {
    const m = makePi()
    registerSessionNaming(m.pi, { TMUX: "x", TMUX_PANE: "%2" })
    await withTTY(async () => {
      await m.handlers.session_info_changed!({ name: "my-session" }, ctx([]))
      await m.handlers.session_info_changed!({}, ctx([]))
    })
    expect(m.execs).toEqual([
      { cmd: "tmux", args: ["rename-window", "-t", "%2", "my-session"] },
      { cmd: "tmux", args: ["rename-window", "-t", "%2", "pi"] },
    ])
  })

  test("no current context: window follows the session's own name", async () => {
    const m = makePi()
    ;(m.pi as any).setName("mine")
    registerSessionNaming(m.pi, { TMUX: "x" })
    await withTTY(() => m.handlers.session_start!({}, ctx([])))
    expect(m.execs).toEqual([
      { cmd: "tmux", args: ["rename-window", "mine"] },
    ])
  })
})
