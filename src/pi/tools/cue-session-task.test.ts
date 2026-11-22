import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE, currentContext } from "../lib/current-context"
import { currentTask } from "../lib/session-task"
import { applySessionTask as apply } from "./cue-session-task"

const applySessionTask = (p: ExtensionAPI, c: Parameters<typeof apply>[1], a: string | undefined) =>
  apply(p, c, a, () => store)

let store: string
let branch: { type: string; customType: string; data: unknown }[]
let pi: ExtensionAPI
let ctx: Parameters<typeof applySessionTask>[1]

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "cue-session-task-"))
  for (const t of ["o/r/c/task/a.md", "o/r/d/task/b.md"]) {
    await mkdir(join(store, t, ".."), { recursive: true })
    await writeFile(join(store, t), "---\nstatus: open\n---\n")
  }
  branch = [{ type: "custom", customType: CUE_CONTEXT_TYPE, data: { address: "o/r/c" } }]
  pi = {
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
    setSessionName: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI
  ctx = {
    cwd: store,
    hasUI: false,
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch as never },
  }
})

afterEach(async () => {
  delete process.env.CUE_TASK
  await rm(store, { recursive: true, force: true })
})

describe("applySessionTask", () => {
  test("sets a task in the current context and exports CUE_TASK", async () => {
    await applySessionTask(pi, ctx, "o/r/c/task/a.md")
    expect(currentTask(branch as never)).toBe("o/r/c/task/a.md")
    expect(process.env.CUE_TASK).toBe("o/r/c/task/a.md")
  })

  test("switching to a task elsewhere links its context", async () => {
    await applySessionTask(pi, ctx, "o/r/c/task/a.md")
    await applySessionTask(pi, ctx, "o/r/d/task/b.md")
    expect(currentContext(branch as never)).toBe("o/r/d")
    expect(currentTask(branch as never)).toBe("o/r/d/task/b.md")
  })

  test("no address clears", async () => {
    await applySessionTask(pi, ctx, "o/r/c/task/a.md")
    const r = await applySessionTask(pi, ctx, undefined)
    expect(r.previous).toBe("o/r/c/task/a.md")
    expect(currentTask(branch as never)).toBeUndefined()
    expect(process.env.CUE_TASK).toBeUndefined()
  })

  test("rejects non-task and missing addresses", async () => {
    await expect(applySessionTask(pi, ctx, "o/r/c")).rejects.toThrow("not a task address")
    await expect(applySessionTask(pi, ctx, "o/r/c/task/x.md")).rejects.toThrow("no such task")
  })
})
