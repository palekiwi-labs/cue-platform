import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { newSession, tmuxWindowArgs } from "./cue-browser"

describe("newSession here", () => {
  const run = (note?: string, handoff?: string) => {
    const sent: string[] = []
    const pi = { sendUserMessage: (m: string) => sent.push(m) } as unknown as ExtensionAPI
    const ctx = { cwd: "/w", isIdle: () => true } as unknown as ExtensionContext
    expect(newSession(pi, ctx, "a/b/c", "here", note, handoff)).toBeUndefined()
    return sent
  }

  test("passes only the selected hand-off to the inject command", () => {
    expect(run(undefined, "a/b/c/trace/handoff-x.md")).toEqual([
      "/resume-open new a/b/c --handoff a/b/c/trace/handoff-x.md",
    ])
  })

  test("no hand-off: the context alone, note kept", () => {
    expect(run()).toEqual(["/resume-open new a/b/c"])
    expect(run("see run")).toEqual(["/resume-open new a/b/c see run"])
  })
})

describe("tmuxWindowArgs", () => {
  test("runs the command under direnv exec in the window cwd", () => {
    expect(tmuxWindowArgs("ctx", "/home/pl/code/x", "pi '/cue:context:inject a/b/c'")).toEqual([
      "new-window",
      "-n",
      "ctx",
      "-c",
      "/home/pl/code/x",
      "direnv exec '/home/pl/code/x' pi '/cue:context:inject a/b/c'",
    ])
  })

  test("quotes a cwd containing a single quote", () => {
    expect(tmuxWindowArgs("w", "/tmp/it's", "pi").at(-1)).toBe("direnv exec '/tmp/it'\\''s' pi")
  })
})
