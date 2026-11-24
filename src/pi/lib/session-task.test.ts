import { describe, expect, test } from "bun:test"
import { CUE_CONTEXT_TYPE } from "./current-context"
import {
  SESSION_STATUS_KEY,
  SESSION_TASK_TYPE,
  currentTask,
  linkGuardError,
  publishTmuxTask,
  normalizeTaskAddress,
  sessionStatusText,
  syncSessionState,
  setSessionTask,
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

describe("publishTmuxTask", () => {
  const tty = process.stdout.isTTY
  const run = (task: string | undefined, env: NodeJS.ProcessEnv) => {
    const calls: string[][] = []
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    try {
      publishTmuxTask(task, env, (args) => calls.push(args))
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true })
    }
    return calls
  }
  const tmux = { TMUX: "/tmp/t", TMUX_PANE: "%1" }

  test("sets the task slug on the window", () => {
    expect(run("o/r/c/task/a.md", tmux)).toEqual([
      ["set-option", "-wq", "-t", "%1", "@pi_task", "a"],
    ])
  })

  test("unsets it without a task", () => {
    expect(run(undefined, tmux)).toEqual([["set-option", "-wqu", "-t", "%1", "@pi_task"]])
  })

  test("does nothing outside tmux", () => {
    expect(run("o/r/c/task/a.md", {})).toEqual([])
  })
})

describe("setSessionTask", () => {
  const setup = () => {
    const branch: { type: string; customType: string; data: unknown }[] = [
      { type: "custom", customType: CUE_CONTEXT_TYPE, data: { address: "o/r/c" } },
    ]
    const emitted: [string, unknown][] = []
    const pi = {
      appendEntry: (customType: string, data: unknown) =>
        branch.push({ type: "custom", customType, data }),
      events: { emit: (name: string, data: unknown) => emitted.push([name, data]) },
    } as never
    const ctx = {
      sessionManager: { getBranch: () => branch as never, getSessionId: () => "s1" },
    }
    return { pi, ctx, emitted, branch }
  }

  test("a genuine set emits cue:task-set with the session id", () => {
    const s = setup()
    setSessionTask(s.pi as never, s.ctx as never, "o/r/c/task/a.md")
    expect(s.emitted).toEqual([
      ["cue:task-set", { address: "o/r/c/task/a.md", sessionId: "s1", reason: "selection" }],
    ])
  })

  test("the reason travels for session birth; same-task sets and clears emit nothing", () => {
    const s = setup()
    setSessionTask(s.pi as never, s.ctx as never, "o/r/c/task/a.md", "session_birth")
    expect(s.emitted[0]![1]).toMatchObject({ reason: "session_birth" })
    setSessionTask(s.pi as never, s.ctx as never, "o/r/c/task/a.md")
    setSessionTask(s.pi as never, s.ctx as never, null)
    expect(s.emitted).toHaveLength(1)
  })
})
