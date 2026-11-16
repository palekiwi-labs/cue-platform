import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SpeakResult } from "../speech"
import { TURN_SUMMARY_TYPE } from "../turn-summary/turns"
import { openTurnSummary, registerTurnSummary, SUMMARY_SHORTCUT, SUMMARY_SPEAK_KEY } from "./turn-summary"

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
  })
})
