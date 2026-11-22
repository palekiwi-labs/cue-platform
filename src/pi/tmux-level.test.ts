import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS } from "./lib/context-usage"
import { levelOf, registerTmuxLevel, THRESHOLDS_CHANGED_EVENT, TMUX_LEVEL_OPTION } from "./tmux-level"

const usage = (tokens: number | null) => ({ getContextUsage: () => ({ tokens }) })

describe("levelOf", () => {
  test("classifies tokens against the given thresholds", () => {
    const t = () => ({ caution: 10, soft: 20, hard: 30 })
    expect(levelOf(usage(5), t)).toBe("nominal")
    expect(levelOf(usage(25), t)).toBe("exceeded_soft")
    expect(levelOf(usage(null), t)).toBeUndefined()
    expect(levelOf({}, t)).toBeUndefined()
  })
})

describe("registerTmuxLevel", () => {
  function setup(env: NodeJS.ProcessEnv, isTTY = true) {
    const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {}
    const events: Record<string, (d: unknown) => void> = {}
    const calls: string[][] = []
    const pi = {
      on: (name: string, fn: (e: unknown, c: unknown) => unknown) => (handlers[name] = fn),
      events: { on: (name: string, fn: (d: unknown) => void) => (events[name] = fn) },
      exec: async (_cmd: string, args: string[]) => (calls.push(args), { stdout: "", code: 0 }),
    } as unknown as ExtensionAPI
    registerTmuxLevel(pi, () => DEFAULT_THRESHOLDS, env, isTTY)
    return { handlers, events, calls }
  }

  test("publishes on change only, and on a thresholds change", () => {
    const { handlers, events, calls } = setup({ TMUX: "1", TMUX_PANE: "%3" })
    handlers.session_start!({}, usage(1_000))
    handlers.agent_end!({}, usage(2_000))
    handlers.agent_end!({}, usage(90_000))
    events[THRESHOLDS_CHANGED_EVENT]!(usage(150_000))
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "%3", TMUX_LEVEL_OPTION, "nominal"],
      ["set-option", "-w", "-t", "%3", TMUX_LEVEL_OPTION, "caution"],
      ["set-option", "-w", "-t", "%3", TMUX_LEVEL_OPTION, "critical"],
    ])
  })

  test("does nothing outside tmux or without a tty", () => {
    expect(Object.keys(setup({}).handlers)).toEqual([])
    expect(Object.keys(setup({ TMUX: "1", TMUX_PANE: "%3" }, false).handlers)).toEqual([])
  })
})
