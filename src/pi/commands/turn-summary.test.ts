import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SpeakResult } from "../speech"
import type { SpeechProgress } from "../speech/nats-sender"
import { TURN_SUMMARY_TYPE } from "../turn-summary/turns"
import { openTurnSummary, registerTurnSummary, SUMMARY_SHORTCUT, SUMMARY_SPEAK_KEY, wrapLines } from "./turn-summary"

const ESC = "\x1b"

const branch = [
  { type: "message", id: "u1", message: { role: "user", content: "first" } },
  { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
  { type: "message", id: "u2", message: { role: "user", content: "second" } },
  { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
  { type: "custom", id: "s1", customType: TURN_SUMMARY_TYPE, data: { turnId: "u1", text: "summary one" } },
  { type: "custom", id: "s2", customType: TURN_SUMMARY_TYPE, data: { turnId: "u2", text: "summary two" } },
]

function fakeCtx() {
  const notes: string[] = []
  const keys: string[] = []
  let rendered: string[] = []
  const tui = {
    terminal: { rows: 30 },
    requestRender: () => {},
    showOverlay: () => ({ hide: () => {} }),
  }
  const theme = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }
  const kb = { matches: (data: string, id: string) => id === "tui.select.cancel" && data === ESC }
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (msg: string) => notes.push(msg),
      custom: async (factory: Function) =>
        new Promise<undefined>((resolve) => {
          const component = factory(tui, theme, kb, () => resolve(undefined))
          rendered = component.render(100)
          for (const key of keys) component.handleInput(key)
        }),
    },
  } as unknown as ExtensionContext
  return { ctx, notes, keys, rendered: () => rendered }
}

const pi = {} as ExtensionAPI

function speaker(result: SpeakResult) {
  const requests: (readonly string[])[] = []
  return { requests, request: (texts: readonly string[]) => (requests.push(texts), result) }
}

describe("speaking from the summary popup", () => {
  test("s requests speech of the shown summary and reports it", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx()
    const s = speaker("sent")
    keys.push(SUMMARY_SPEAK_KEY, "h", SUMMARY_SPEAK_KEY, "q")
    await openTurnSummary(pi, ctx, s)
    expect(s.requests).toEqual([["summary two"], ["summary one"]])
    expect(notes).toEqual(["Speaking the turn summary", "Speaking the turn summary"])
    expect(rendered().at(-1)).toContain("s speak")
  })

  test("a refused request is reported", async () => {
    const { ctx, notes, keys } = fakeCtx()
    keys.push(SUMMARY_SPEAK_KEY, "q")
    await openTurnSummary(pi, ctx, speaker("busy"))
    expect(notes).toEqual(["Speech request refused while the agent is running"])
  })

  test("without speech, s does nothing and no hint shows", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx()
    keys.push(SUMMARY_SPEAK_KEY, "q")
    await openTurnSummary(pi, ctx)
    expect(notes).toEqual([])
    expect(rendered().at(-1)).not.toContain("s speak")
  })
})

describe("registerTurnSummary", () => {
  test("registers the summary command and the shortcut", () => {
    const commands: string[] = []
    const shortcuts: string[] = []
    const api = {
      on: () => {},
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (key: string) => shortcuts.push(key),
    } as unknown as ExtensionAPI
    registerTurnSummary(api)
    expect(commands).toEqual(["cue:summary"])
    expect(shortcuts).toEqual([SUMMARY_SHORTCUT])
    expect(SUMMARY_SHORTCUT).toBe("alt+u")
  })
})

describe("wrapLines", () => {
  test("wraps paragraphs and reports source offsets", () => {
    const text = "one two three\n\nfour five"
    const lines = wrapLines(text, 8)
    expect(lines.map((l) => l.text)).toEqual(["one two", "three", "", "four", "five"])
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 7],
      [8, 13],
      [14, 15],
      [15, 19],
      [20, 24],
    ])
    for (const l of lines) expect(text.slice(l.start, Math.min(l.end, text.length)).startsWith(l.text) || l.text === "").toBe(true)
  })

  test("width 0 yields nothing", () => {
    expect(wrapLines("abc", 0)).toEqual([])
  })
})

describe("karaoke highlighting in the summary popup", () => {
  interface Run {
    lines(): string[]
  }

  function karaoke(rows: number, width = 40): { start(): Promise<Run>; events: SpeechProgress[] } {
    const events: SpeechProgress[] = []
    let progress: ((event: SpeechProgress) => void) | undefined
    let rendered: string[] = []
    const tui = {
      terminal: { rows },
      requestRender: () => {},
      showOverlay: () => ({ hide: () => {} }),
    }
    const theme = {
      fg: (color: string, s: string) => `<${color}>${s}`,
      bold: (s: string) => `*${s}*`,
    }
    const kb = { matches: (data: string, id: string) => id === "tui.select.cancel" && data === ESC }
    const ctx = {
      hasUI: true,
      cwd: "/tmp",
      isIdle: () => true,
      sessionManager: { getBranch: () => branch },
      ui: {
        notify: () => {},
        custom: async (factory: Function) => {
          const component = factory(tui, theme, kb, () => {})
          component.handleInput(SUMMARY_SPEAK_KEY)
          for (const event of events) progress?.(event)
          rendered = component.render(width)
        },
      },
    } as unknown as ExtensionContext
    const speaker = {
      request: (_texts: readonly string[], _ctx: unknown, onProgress?: (event: SpeechProgress) => void) => {
        progress = onProgress
        return "sent" as const
      },
    }
    return {
      events,
      start: async () => {
        await openTurnSummary(pi, ctx, speaker)
        return { lines: () => rendered }
      },
    }
  }

  test("chunk events highlight the spoken chunk and dim the rest", async () => {
    const k = karaoke(30)
    k.events.push({ type: "chunk", utt: "u", seq: 0, text: "summary two" })
    const r = await k.start()
    const all = r.lines().join("\n")
    expect(all).toContain("<accent>*summary two*")
    expect(all).not.toContain("summary one")
  })

  test("finished speech clears the highlight and scroll", async () => {
    const k = karaoke(30)
    k.events.push({ type: "chunk", utt: "u", seq: 0, text: "summary two" }, { type: "finished", utt: "u" })
    const r = await k.start()
    const all = r.lines().join("\n")
    expect(all).not.toContain("<accent>*summary")
    expect(all).toContain("   summary two")
  })

  test("long summaries scroll to follow the spoken chunk", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `paragraph ${i} of a fairly long summary`).join("\n\n")
    const longBranch = [
      { type: "message", id: "u1", message: { role: "user", content: "prompt" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
      { type: "custom", id: "s1", customType: TURN_SUMMARY_TYPE, data: { turnId: "u1", text: long } },
    ]
    const events: SpeechProgress[] = []
    let progress: ((event: SpeechProgress) => void) | undefined
    let rendered: string[] = []
    const tui = { terminal: { rows: 16 }, requestRender: () => {}, showOverlay: () => ({ hide: () => {} }) }
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s }
    const kb = { matches: (data: string, id: string) => id === "tui.select.cancel" && data === ESC }
    const ctx = {
      hasUI: true,
      cwd: "/tmp",
      isIdle: () => true,
      sessionManager: { getBranch: () => longBranch },
      ui: {
        notify: () => {},
        custom: async (factory: Function) => {
          const component = factory(tui, theme, kb, () => {})
          component.handleInput(SUMMARY_SPEAK_KEY)
          for (const event of events) progress?.(event)
          rendered = component.render(40)
        },
      },
    } as unknown as ExtensionContext
    const speaker = {
      request: (_t: readonly string[], _c: unknown, onProgress?: (e: SpeechProgress) => void) => {
        progress = onProgress
        return "sent" as const
      },
    }
    events.push({ type: "chunk", utt: "u", seq: 0, text: "paragraph 25 of a fairly long summary" })
    await openTurnSummary(pi, ctx, speaker)
    const body = rendered.filter((l) => l.includes("│"))
    expect(body.some((l) => l.includes("paragraph 25"))).toBe(true)
    expect(body.every((l) => !l.includes("paragraph 0 of"))).toBe(true)
  })
})
