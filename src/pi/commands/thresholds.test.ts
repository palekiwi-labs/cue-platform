import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import cuePlugins from "../index"
import { DEFAULT_THRESHOLDS } from "../lib/context-usage"
import { SessionThresholds } from "../lib/session-thresholds"
import { applyResult, popupWidth, type PopupState, ThresholdsPopup } from "./thresholds"

const plain = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  shiftRight: "\x1b[1;2C",
  shiftLeft: "\x1b[1;2D",
  tab: "\t",
  enter: "\r",
  escape: "\x1b",
}

function popup(state: Partial<PopupState> = {}): ThresholdsPopup {
  return new ThresholdsPopup(plain, {
    thresholds: DEFAULT_THRESHOLDS,
    contextWindow: 200_000,
    tokens: 50_000,
    ...state,
  })
}

describe("ThresholdsPopup render", () => {
  test("boxed popup with bar, markers, values and key hints", () => {
    const p = popup()
    const width = popupWidth(120)
    const lines = p.render(width)
    expect(lines[0]).toStartWith("╭─ context thresholds ")
    expect(lines.every((l) => visibleWidth(l) === width)).toBe(true)
    const text = lines.join("\n")
    expect(text).toContain("window 200,000 · usage 50,000 (25%)")
    expect(text).toContain("> caution    80,000   40%")
    expect(text).toContain("  soft      100,000   50%")
    expect(text).toContain("  hard      140,000   70%")
    expect(lines.at(-1)).toContain("enter apply")
    expect(lines.at(-1)).toContain("esc cancel")
  })

  test("marker letters sit under the bar at their share of the window", () => {
    const lines = popup().render(44)
    const labels = lines[3]!.slice(2, 42)
    expect(labels.indexOf("C")).toBe(Math.round(0.4 * 39))
    expect(labels.indexOf("S")).toBe(Math.round(0.5 * 39))
    expect(labels.indexOf("H")).toBe(Math.round(0.7 * 39))
  })

  test("unknown usage when tokens is null", () => {
    const text = popup({ tokens: null }).render(80).join("\n")
    expect(text).toContain("usage unknown")
  })
})

describe("ThresholdsPopup input", () => {
  test("up/down and tab cycle the selected marker", () => {
    const p = popup()
    p.handleInput(KEY.down)
    expect(p.marker()).toBe("soft")
    p.handleInput(KEY.tab)
    expect(p.marker()).toBe("hard")
    p.handleInput(KEY.down)
    expect(p.marker()).toBe("caution")
    p.handleInput(KEY.up)
    expect(p.marker()).toBe("hard")
  })

  test("left/right move by 5k, shift and H/L by 1k", () => {
    const p = popup()
    p.handleInput(KEY.right)
    expect(p.values.caution).toBe(85_000)
    p.handleInput("h")
    expect(p.values.caution).toBe(80_000)
    p.handleInput(KEY.shiftRight)
    expect(p.values.caution).toBe(81_000)
    p.handleInput("H")
    p.handleInput(KEY.shiftLeft)
    expect(p.values.caution).toBe(79_000)
    p.handleInput("L")
    p.handleInput("l")
    expect(p.values.caution).toBe(85_000)
  })

  test("markers clamp between neighbours and the window", () => {
    const p = popup()
    for (let i = 0; i < 10; i++) p.handleInput(KEY.right)
    expect(p.values.caution).toBe(99_000)
    p.handleInput(KEY.down)
    p.handleInput(KEY.down)
    for (let i = 0; i < 20; i++) p.handleInput(KEY.right)
    expect(p.values.hard).toBe(200_000)
    for (let i = 0; i < 40; i++) p.handleInput(KEY.left)
    expect(p.values.hard).toBe(101_000)
    expect(p.error()).toBeNull()
  })

  test("r resets to the defaults", () => {
    const p = popup({ thresholds: { caution: 10_000, soft: 20_000, hard: 30_000 } })
    p.handleInput("r")
    expect(p.values).toEqual(DEFAULT_THRESHOLDS)
  })

  test("enter applies the edited values, esc cancels", () => {
    const p = popup()
    p.handleInput(KEY.right)
    expect(p.handleInput(KEY.enter)).toEqual({
      kind: "apply",
      thresholds: { caution: 85_000, soft: 100_000, hard: 140_000 },
    })
    expect(p.handleInput(KEY.escape)).toEqual({ kind: "cancel" })
    expect(p.handleInput(KEY.right)).toBeUndefined()
  })

  test("enter is refused while the values are invalid for the window", () => {
    const p = popup({ contextWindow: 128_000 })
    expect(p.error()).toMatch(/context window/)
    expect(p.handleInput(KEY.enter)).toBeUndefined()
    expect(p.render(80).join("\n")).toContain("hard must not exceed")
    p.handleInput(KEY.up)
    p.handleInput(KEY.left)
    expect(p.values.hard).toBe(128_000)
    expect(p.handleInput(KEY.enter)?.kind).toBe("apply")
  })
})

describe("applyResult", () => {
  test("cancel leaves the holder alone and shows nothing", () => {
    const h = new SessionThresholds()
    expect(applyResult(h, { kind: "cancel" }, 200_000)).toBeNull()
    expect(h.get()).toEqual(DEFAULT_THRESHOLDS)
  })

  test("apply sets the holder and reports the values", () => {
    const h = new SessionThresholds()
    const shown = applyResult(
      h,
      { kind: "apply", thresholds: { caution: 90_000, soft: 120_000, hard: 160_000 } },
      200_000,
    )
    expect(shown?.type).toBe("info")
    expect(shown?.message).toContain("caution 90,000 / soft 120,000 / hard 160,000")
    expect(h.get().soft).toBe(120_000)
  })
})

describe("/thresholds end to end", () => {
  function harness() {
    const tools: ToolDefinition<any>[] = []
    const commands: Record<string, { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }> = {}
    const handlers: Record<string, (() => void)[]> = {}
    const pi = {
      registerTool: (t: ToolDefinition<any>) => tools.push(t),
      registerShortcut: () => {},
      registerCommand: (name: string, o: any) => { commands[name] = o },
      sendUserMessage: () => {},
      on: (event: string, fn: () => void) => { (handlers[event] ??= []).push(fn) },
      exec: async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
    } as unknown as ExtensionAPI
    cuePlugins(pi)
    return { tools, commands, handlers }
  }

  function commandCtx(keys: string[], notes: string[]): ExtensionCommandContext {
    return {
      cwd: "/work",
      hasUI: true,
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
      ui: {
        notify: (m: string) => notes.push(m),
        custom: (factory: any) =>
          new Promise((resolve) => {
            const tui = { requestRender: () => {} }
            const c = factory(tui, plain, {}, resolve)
            c.render(80)
            for (const k of keys) c.handleInput(k)
          }),
      },
    } as unknown as ExtensionCommandContext
  }

  const toolCtx = {
    cwd: "/work",
    sessionManager: { getSessionId: () => "s" },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
  } as unknown as ExtensionToolContext

  test("applied thresholds change the cue-context-usage report until a new session", async () => {
    const { tools, commands, handlers } = harness()
    const usage = tools.find((t) => t.name === "cue-context-usage")!
    const log = tools.find((t) => t.name === "cue-log")!

    const before: any = await usage.execute("id", {}, undefined, undefined, toolCtx)
    expect(before.content[0].text).toContain("Level: CAUTION")

    const notes: string[] = []
    await commands.thresholds!.handler("", commandCtx([KEY.right, KEY.right, KEY.right, KEY.enter], notes))
    expect(notes[0]).toContain("caution 95,000")

    const after: any = await usage.execute("id", {}, undefined, undefined, toolCtx)
    expect(after.content[0].text).toContain("Limits: caution 95,000 / soft 100,000 / hard 140,000")
    expect(after.content[0].text).toContain("Level: NOMINAL")
    expect(after.details.caution_limit).toBe(95_000)

    const logged: any = await log.execute("id", { title: "t", context: "c" }, undefined, undefined, toolCtx)
    expect(logged.content[0].text).toContain("Context: nominal.")

    handlers.session_start![0]!()
    const fresh: any = await usage.execute("id", {}, undefined, undefined, toolCtx)
    expect(fresh.details.caution_limit).toBe(DEFAULT_THRESHOLDS.caution)
  })

  test("esc leaves the thresholds unchanged", async () => {
    const { tools, commands } = harness()
    const notes: string[] = []
    await commands.thresholds!.handler("", commandCtx([KEY.right, KEY.escape], notes))
    expect(notes).toEqual([])
    const usage = tools.find((t) => t.name === "cue-context-usage")!
    const r: any = await usage.execute("id", {}, undefined, undefined, toolCtx)
    expect(r.details.caution_limit).toBe(DEFAULT_THRESHOLDS.caution)
  })
})
