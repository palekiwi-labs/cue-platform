import { describe, expect, test } from "bun:test"
import { tmuxWindowArgs } from "./cue-browser"

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
