import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerStoreCommit } from "./store-commit"

const ADDRESS = "org/repo/ctx"

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>

let store: string

function git(...args: string[]): string {
  return spawnSync("git", ["-C", store, ...args], { encoding: "utf8" }).stdout.trim()
}

function initRepo(): void {
  git("init", "-q", "-b", "master")
  git("config", "user.name", "test")
  git("config", "user.email", "test@example.com")
  git("config", "commit.gpgsign", "false")
}

function harness(status = { code: 0, stdout: JSON.stringify({ store: "", address: ADDRESS }), stderr: "" }) {
  let handler: Handler | undefined
  const cueCalls: string[][] = []
  const pi = {
    on: (_: string, h: Handler) => (handler = h),
    exec: async (cmd: string, argv: string[]) => {
      if (cmd === "cue") {
        cueCalls.push(argv)
        return { ...status, stdout: status.stdout.replace('"store":""', `"store":${JSON.stringify(store)}`) }
      }
      const r = spawnSync(cmd, argv, { encoding: "utf8" })
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
    },
  }
  registerStoreCommit(pi as never)
  const warnings: string[] = []
  const ctx = { cwd: store, hasUI: true, ui: { notify: (m: string) => warnings.push(m) } }
  const fire = (e: Record<string, unknown>) => handler!(e, ctx)
  return { fire, cueCalls, warnings }
}

const logged = (title: string, input: Record<string, unknown> = { context: "ctx" }) => ({
  toolName: "cue-log",
  isError: false,
  input: { title, ...input },
})

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "store-commit-"))
})

afterEach(() => {
  rmSync(store, { recursive: true, force: true })
})

describe("registerStoreCommit", () => {
  test("commits every change with the address and log title", async () => {
    initRepo()
    writeFileSync(join(store, "a.json"), "{}")
    const h = harness()
    await h.fire(logged("Add the thing\nsecond line"))
    expect(git("log", "--format=%s")).toBe(`${ADDRESS}: Add the thing`)
    expect(git("status", "--porcelain")).toBe("")
    expect(h.warnings).toEqual([])
    expect(h.cueCalls[0]).toEqual(["status", "--json", "--context", "ctx"])
  })

  test("ignores other tools and failed cue-log calls", async () => {
    initRepo()
    writeFileSync(join(store, "a.json"), "{}")
    const h = harness()
    await h.fire({ toolName: "bash", isError: false, input: {} })
    await h.fire({ ...logged("x"), isError: true })
    expect(h.cueCalls).toEqual([])
    expect(git("log", "--format=%s")).toBe("")
  })

  test("is silent when the store is not a git repo", async () => {
    writeFileSync(join(store, "a.json"), "{}")
    const h = harness()
    await h.fire(logged("x"))
    expect(h.warnings).toEqual([])
  })

  test("leaves an enclosing repo alone when the store is a subdirectory", async () => {
    initRepo()
    const outer = store
    store = join(outer, "sub")
    mkdirSync(store)
    writeFileSync(join(store, "a.json"), "{}")
    const h = harness()
    await h.fire(logged("x"))
    store = outer
    expect(git("log", "--format=%s")).toBe("")
    expect(h.warnings).toEqual([])
  })

  test("is silent when there is nothing to commit", async () => {
    initRepo()
    writeFileSync(join(store, "a.json"), "{}")
    git("add", "-A")
    git("commit", "-qm", "init")
    const h = harness()
    await h.fire(logged("x"))
    expect(git("log", "--format=%s")).toBe("init")
    expect(h.warnings).toEqual([])
  })

  test("warns when the context cannot be resolved", async () => {
    const h = harness({ code: 1, stdout: "", stderr: "no context" })
    await h.fire(logged("x"))
    expect(h.warnings[0]).toContain("no context")
  })

  test("warns when the commit fails", async () => {
    initRepo()
    writeFileSync(join(store, "a.json"), "{}")
    writeFileSync(join(store, ".git", "index.lock"), "")
    const h = harness()
    await h.fire(logged("x"))
    expect(h.warnings[0]).toContain("store not committed")
  })
})
