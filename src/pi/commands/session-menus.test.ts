import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { menuColumns } from "../browser/action-menu"
import { SessionSpeechMode } from "../speech/settings"
import { sessionActions, sessionSettings } from "./session-menus"

function fakePi(level = "medium") {
  const sent: { text: string; options: unknown }[] = []
  const levels: string[] = []
  const pi = {
    sendUserMessage: async (text: string, options: unknown) => {
      sent.push({ text, options })
    },
    getThinkingLevel: () => level,
    setThinkingLevel: (l: string) => levels.push(l),
    getSessionName: () => undefined,
  } as unknown as ExtensionAPI
  return { pi, sent, levels }
}

function fakeCtx() {
  const calls: string[] = []
  const ctx = {
    abort: () => calls.push("abort"),
    shutdown: () => calls.push("shutdown"),
    ui: { input: async () => "todo" },
  } as unknown as ExtensionContext
  return { ctx, calls }
}

describe("sessionActions", () => {
  test("lists the session actions in menu columns", () => {
    const { pi } = fakePi()
    const cols = menuColumns(sessionActions(pi, fakeCtx().ctx))
    expect(cols.map((c) => [c.section, c.rows.map((b) => b.label)])).toEqual([
      ["act", ["interrupt", "rename", "label"]],
      ["open", ["new session"]],
      ["view", ["reload", "quit"]],
    ])
  })

  test("interrupt and quit call the context directly", () => {
    const { pi } = fakePi()
    const { ctx, calls } = fakeCtx()
    const actions = sessionActions(pi, ctx)
    actions.find((b) => b.label === "interrupt")!.run!()
    actions.find((b) => b.label === "quit")!.run!()
    expect(calls).toEqual(["abort", "shutdown"])
  })

  test("command-backed actions run as extension commands", async () => {
    const { pi, sent } = fakePi()
    const actions = sessionActions(pi, fakeCtx().ctx)
    actions.find((b) => b.label === "new session")!.run!()
    await actions.find((b) => b.label === "label")!.run!()
    expect(sent).toEqual([
      { text: "/cue:new-session", options: { expandPromptTemplates: true } },
      { text: "/label todo", options: { expandPromptTemplates: true } },
    ])
  })
})

describe("sessionSettings", () => {
  test("thinking starts at the current level and applies the picked one", () => {
    const { pi, levels } = fakePi("low")
    const [thinking] = sessionSettings(pi)
    expect(thinking!.values[thinking!.current]).toBe("low")
    thinking!.apply(thinking!.values.indexOf("high"))
    expect(levels).toEqual(["high"])
  })
})

describe("speech setting", () => {
  test("offers the three speech modes, starting at the session's mode", () => {
    const appended: unknown[] = []
    const session = new SessionSpeechMode({ appendEntry: (_t: string, d: unknown) => appended.push(d) } as never)
    const speech = sessionSettings(fakePi().pi, session).find((s) => s.label === "speech")!
    expect(speech.group).toBe("display")
    expect(speech.values).toEqual(["off", "message", "live"])
    expect(speech.values[speech.current]).toBe("off")
    speech.apply(speech.values.indexOf("message"))
    expect(session.mode).toBe("message")
    expect(appended).toEqual([{ mode: "message" }])
    const again = sessionSettings(fakePi().pi, session).find((s) => s.label === "speech")!
    expect(again.values[again.current]).toBe("message")
  })

  test("is not listed where the session cannot speak", () => {
    expect(sessionSettings(fakePi().pi).map((s) => s.label)).toEqual(["thinking", "style"])
  })
})
