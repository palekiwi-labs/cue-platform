import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { liveFiles } from "./log-files"
import { acquireLock, lockPath } from "./lock"
import { type CompactionKind, contextFiles, PROPOSAL_FILE, runPipeline } from "./pipeline"
import { maybeCompact, registerCompactionTrigger } from "./trigger"

const ADDRESS = "org/repo/ctx"
const BASE = 1792814113359612000n

let store: string
let root: string
let dir: string
let runDir: string
let events: { kind: CompactionKind; details: Record<string, unknown> }[]

function file(i: number): string {
  return (BASE + BigInt(i)).toString().padStart(20, "0") + ".json"
}

function writeEntry(i: number): void {
  writeFileSync(
    join(dir, file(i)),
    `{"timestamp":${BASE + BigInt(i)},"title":"entry ${i}","trace":null,"found":[],"decided":[],"open":[]}`,
  )
}

const record = async (kind: CompactionKind, details: Record<string, unknown>) => {
  events.push({ kind, details })
}

function proposalFor(covers: string[]): string {
  return "```json\n" + JSON.stringify({ summaries: [{ covers, title: "Early", found: [], decided: [], open: [] }] }) + "\n```"
}

const head = () => Array.from({ length: 11 }, (_, i) => file(i + 1))
const args = () => ({ store, address: ADDRESS, runDir, root })

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "pipeline-"))
  root = join(store, "cache")
  dir = join(store, ADDRESS, "log")
  runDir = join(root, ADDRESS, "run-1")
  events = []
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 16; i++) writeEntry(i)
})

afterEach(() => rmSync(store, { recursive: true, force: true }))

describe("runPipeline", () => {
  test("applies a valid proposal and records start and success", async () => {
    let prompt = ""
    const outcome = await runPipeline(args(), {
      runAgent: async (p) => {
        prompt = p
        return { ok: true, text: proposalFor(head()) }
      },
      record,
    })
    expect(outcome).toBe("compacted")
    expect(prompt).toContain(join(runDir, "bundle.json"))
    expect(liveFiles(dir)).toHaveLength(6)
    expect(existsSync(join(runDir, PROPOSAL_FILE))).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(["log_compaction_started", "log_compacted"])
    expect(events[1]!.details).toMatchObject({ run_dir: runDir, replaced: 11, summaries: [`${ADDRESS}/log/${file(11)}`] })
    expect(existsSync(lockPath(root, ADDRESS))).toBe(false)
  })

  test("records failure and leaves the log alone on an invalid proposal", async () => {
    const outcome = await runPipeline(args(), {
      runAgent: async () => ({ ok: true, text: proposalFor(head().slice(1)) }),
      record,
    })
    expect(outcome).toBe("failed")
    expect(liveFiles(dir)).toHaveLength(16)
    expect(events.map((e) => e.kind)).toEqual(["log_compaction_started", "log_compaction_failed"])
    expect(String(events[1]!.details.reason)).toContain("not covered")
  })

  test("records failure when the agent fails", async () => {
    const outcome = await runPipeline(args(), { runAgent: async () => ({ ok: false, text: "timeout" }), record })
    expect(outcome).toBe("failed")
    expect(events[1]!.details.reason).toBe("agent: timeout")
  })

  test("aborts when an entry is written during the agent run", async () => {
    const outcome = await runPipeline(args(), {
      runAgent: async () => {
        writeFileSync(join(dir, file(1)), `{"timestamp":1,"title":"edited","trace":null,"found":[],"decided":[],"open":[]}`)
        return { ok: true, text: proposalFor(head()) }
      },
      record,
    })
    expect(outcome).toBe("failed")
    expect(String(events[1]!.details.reason)).toContain("snapshot changed")
    expect(liveFiles(dir)).toHaveLength(16)
  })

  test("does nothing while another run holds the lock", async () => {
    const release = acquireLock(lockPath(root, ADDRESS))!
    const outcome = await runPipeline(args(), { runAgent: async () => ({ ok: false, text: "" }), record })
    release()
    expect(outcome).toBe("locked")
    expect(events).toEqual([])
  })

  test("does nothing at or below the threshold", async () => {
    rmSync(join(dir, file(16)))
    const outcome = await runPipeline(args(), { runAgent: async () => ({ ok: false, text: "" }), record })
    expect(outcome).toBe("nothing")
    expect(events).toEqual([])
  })
})

describe("contextFiles", () => {
  test("lists spec, plans and only open tasks", () => {
    const ctx = join(store, ADDRESS)
    for (const sub of ["spec", "plan", "task"]) mkdirSync(join(ctx, sub))
    writeFileSync(join(ctx, "spec", "index.md"), "x")
    writeFileSync(join(ctx, "plan", "p.md"), "x")
    writeFileSync(join(ctx, "task", "a.md"), "---\nstatus: open\n---\n")
    writeFileSync(join(ctx, "task", "b.md"), "---\nstatus: complete\n---\n")
    expect(contextFiles(ctx)).toEqual([
      join(ctx, "spec", "index.md"),
      join(ctx, "plan", "p.md"),
      join(ctx, "task", "a.md"),
    ])
  })
})

describe("maybeCompact", () => {
  test("spawns above the threshold only", () => {
    const spawned: string[] = []
    const spawner = (_: unknown, run: string) => void spawned.push(run)
    const paths = { store, address: ADDRESS }
    const run = maybeCompact(paths, spawner, undefined, root)
    expect(run).not.toBeNull()
    expect(run!.startsWith(join(root, ADDRESS))).toBe(true)
    rmSync(join(dir, file(16)))
    expect(maybeCompact(paths, spawner, undefined, root)).toBeNull()
    expect(spawned).toEqual([run!])
  })
})

describe("registerCompactionTrigger", () => {
  type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>

  function harness(status: { code: number; stdout: string; stderr?: string }) {
    let handler: Handler | undefined
    const calls: string[][] = []
    const pi = {
      on: (_: string, h: Handler) => (handler = h),
      exec: async (_: string, argv: string[]) => {
        calls.push(argv)
        return { stderr: "", ...status }
      },
    }
    const spawned: string[] = []
    registerCompactionTrigger(pi as never, (_, run) => void spawned.push(run))
    const warnings: string[] = []
    const ctx = { cwd: store, hasUI: true, ui: { notify: (m: string) => warnings.push(m) } }
    return { fire: (e: Record<string, unknown>) => handler!(e, ctx), calls, spawned, warnings }
  }

  const ok = () => ({ code: 0, stdout: JSON.stringify({ store, address: ADDRESS }) })

  test("spawns after a successful cue-log call and passes its flags", async () => {
    const h = harness(ok())
    await h.fire({ toolName: "cue-log", isError: false, input: { context: "ctx", store } })
    expect(h.spawned).toHaveLength(1)
    expect(h.calls[0]).toEqual(["status", "--json", "--store", store, "--context", "ctx"])
  })

  test("ignores other tools and failed calls", async () => {
    const h = harness(ok())
    await h.fire({ toolName: "bash", isError: false, input: {} })
    await h.fire({ toolName: "cue-log", isError: true, input: {} })
    expect(h.calls).toEqual([])
    expect(h.spawned).toEqual([])
  })

  test("warns instead of throwing when the context cannot be resolved", async () => {
    const h = harness({ code: 1, stdout: "", stderr: "no context" })
    await h.fire({ toolName: "cue-log", isError: false, input: {} })
    expect(h.spawned).toEqual([])
    expect(h.warnings[0]).toContain("no context")
  })
})

describe("legacy summaries", () => {
  test("resolve a context-relative archive and exact stamps from its name", async () => {
    const { archivedOriginals } = await import("./prepare")
    const { entryFrom, readLive } = await import("./log-files")
    const name = `${file(1).slice(0, 20)}-${file(2).slice(0, 20)}`
    const archive = join(dir, ".archive", name)
    mkdirSync(archive, { recursive: true })
    for (const i of [1, 2]) writeFileSync(join(archive, file(i)), `{"timestamp":1,"title":"orig ${i}","trace":null,"found":[],"decided":[],"open":[]}`)
    writeFileSync(join(archive, "manifest.json"), "{}")
    rmSync(join(dir, file(1)))
    const legacy = { from: Number(BASE + 1n), to: Number(BASE + 2n), count: 2, archive: `log/.archive/${name}` }
    writeFileSync(join(dir, file(2)), JSON.stringify({ timestamp: 1, title: "legacy", trace: null, found: [], decided: [], open: [], compacted: legacy }))
    const live = readLive(dir).find((e) => e.file === file(2))!
    expect(entryFrom(live)).toBe((BASE + 1n).toString())
    expect(archivedOriginals(store, ADDRESS, live.entry).map((e) => e.title)).toEqual(["orig 1", "orig 2"])
  })
})
