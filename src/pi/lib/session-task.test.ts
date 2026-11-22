import { describe, expect, test } from "bun:test"
import { CUE_CONTEXT_TYPE } from "./current-context"
import {
  SESSION_STATUS_KEY,
  SESSION_TASK_TYPE,
  currentTask,
  linkGuardError,
  normalizeTaskAddress,
  sessionStatusText,
  syncSessionState,
  taskContextOf,
} from "./session-task"

const link = (address: string) => ({
  type: "custom",
  customType: CUE_CONTEXT_TYPE,
  data: { address },
})
const task = (address: string | null) => ({
  type: "custom",
  customType: SESSION_TASK_TYPE,
  data: { address },
})

describe("task addresses", () => {
  test("derives the context of a task address", () => {
    expect(taskContextOf("o/r/c/task/t.md")).toBe("o/r/c")
    expect(taskContextOf("o/r/c/plan/p.md")).toBeUndefined()
    expect(taskContextOf("o/r/c")).toBeUndefined()
    expect(taskContextOf("o/../c/task/t.md")).toBeUndefined()
  })

  test("normalises stray slashes and whitespace", () => {
    expect(normalizeTaskAddress(" /o/r/c/task/t.md/ ")).toBe("o/r/c/task/t.md")
  })
})

describe("currentTask", () => {
  test("is the newest task entry while its context is current", () => {
    expect(currentTask([link("o/r/c"), task("o/r/c/task/a.md")])).toBe("o/r/c/task/a.md")
  })

  test("a null entry clears it", () => {
    expect(currentTask([link("o/r/c"), task("o/r/c/task/a.md"), task(null)])).toBeUndefined()
  })

  test("is dropped when another context is current", () => {
    expect(currentTask([link("o/r/c"), task("o/r/c/task/a.md"), link("o/r/d")])).toBeUndefined()
  })
})

describe("linkGuardError", () => {
  const branch = [link("o/r/c"), task("o/r/c/task/a.md")]

  test("allows the task's own context", () => {
    expect(linkGuardError(branch, "o/r/c")).toBeUndefined()
  })

  test("refuses another context while a task is active", () => {
    expect(linkGuardError(branch, "o/r/d")).toContain("clear it first")
  })

  test("allows anything without a task", () => {
    expect(linkGuardError([link("o/r/c")], "o/r/d")).toBeUndefined()
  })
})

describe("footer and env", () => {
  test("status text", () => {
    expect(sessionStatusText(undefined, undefined)).toBeUndefined()
    expect(sessionStatusText("o/r/c", undefined)).toBe("c")
    expect(sessionStatusText("o/r/c", "o/r/c/task/a.md")).toBe("c / a")
  })

  test("sets CUE_TASK and the footer, red no context without one", () => {
    const statuses: (string | undefined)[] = []
    const env: NodeJS.ProcessEnv = {}
    const ui = {
      setStatus: (key: string, text: string | undefined) => {
        expect(key).toBe(SESSION_STATUS_KEY)
        statuses.push(text)
      },
      theme: { fg: (_c: "error", t: string) => `<red>${t}</red>` },
    }
    let branch: unknown[] = [link("o/r/c"), task("o/r/c/task/a.md")]
    const ctx = { hasUI: true, ui, sessionManager: { getBranch: () => branch as never } }
    syncSessionState(ctx, env)
    expect(env.CUE_TASK).toBe("o/r/c/task/a.md")
    branch = []
    syncSessionState(ctx, env)
    expect(env.CUE_TASK).toBeUndefined()
    expect(statuses).toEqual(["c / a", "<red>no context</red>"])
  })
})
